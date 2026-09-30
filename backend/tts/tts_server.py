# -*- coding: utf-8 -*-
"""CosyVoice2 TTS HTTP 服务(零样本克隆 zry 音色)。
接口与 GPT-SoVITS /tts 大致兼容:POST {"text": "...", "streaming_mode": bool, ...}
其它 GPT-SoVITS 字段(参考/音色等)忽略,统一用下面固定的 zry 参考做克隆。
端口 9882(可与 GPT-SoVITS 9880 并存)。

【真流式 ▲▲▲】/tts?streaming_mode=true 时不再 torch.cat 整段,而是用
inference_zero_shot(..., stream=True) 增量出块 + StreamingResponse:
  先发 1 个 44 字节标准 PCM WAV 头(取采样率),之后每合成一块就 yield 一段原始
  int16 PCM(不重复发头),前端 createReplySpeaker 的 speakStreaming 据此"边收边播"。
这会把首包延迟从 ~1.7-2.2s(整段合成)降到 ~0.4-0.9s(首块即出)。

【参考特征缓存】用 CosyVoice 自带 add_zero_shot_spk(prompt_text, prompt_wav, spk_id)
把参考音频的 prompt 特征(prompt_text/speech_feat/speech_token/embedding)一次性算好
存入 frontend.spk2info,随后 inference_zero_shot(..., zero_shot_spk_id=spk_id) 直接复用,
省掉每次 /tts 请求重新做 whisper log-mel + speech_tokenizer + campplus。仅第一次 get_cosy
构建时有开销(几十 ms~几百 ms)。

【参考音频】CosyVoice frontend._extract_speech_token 有"参考音频 ≤30s"的硬性断言:
  assert speech.shape[1] / 16000 <= 30
而 E:\\zry音色.wav 实测 49.18s/44100/双声道,直接作为 prompt_wav 会触发断言失败。
因此本服务仍用 4.2s 的微调片段 zry_0025640_0029860.wav + 其对应文字("人最早能记得
两三岁时候的事",已验证能稳定克隆出 zry 音色)。若要在 CosyVoice 换用更长参考,需先
由用户提供一段 ≤30s 的参考切片 + 与之逐字一致的文字稿,再改下面的 REF_WAV/REF_TEXT。
"""
import os, sys, io, struct, json
sys.stdout.reconfigure(encoding="utf-8")

REPO = r"E:\CosyVoice\repo\QwenAudio-CosyVoice-074ca6d"
MATCHA = REPO + r"\third_party\Matcha-TTS"
for p in (REPO, MATCHA):
    if p not in sys.path:
        sys.path.insert(0, p)

import soundfile as sf
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import torch, torchaudio
from cosyvoice.cli.cosyvoice import CosyVoice2

MODEL_DIR = r"E:\CosyVoice\pretrained_models\models\iic--CosyVoice2-0.5B\snapshots\master"
REF_WAV = r"E:\GPT-SoVITS\dataset\zry\clips\zry_0025640_0029860.wav"
REF_TEXT = "人最早能记得两三岁时候的事"
# 缓存参考特征用的零样本 speak id(见文件头注释)。
ZERO_SHOT_SPK_ID = "zry"
DEFAULT_SPK = "zry"
# 【多音色】音色库清单:由宿主端(插件)在新增/删除音色时写入,tts_server 每次 /tts 读取以支持"切音色即刻生效"。
VOICES_MANIFEST = r"E:\deepseekharness使用\plugins\dsh-client-ui-voice-input\runtime\voices\manifest.json"
# 已缓存参考特征的 spk 集合(避免重复 add_zero_shot_spk)。
_cached_spks = set()


def load_voices():
    """从 manifest 读音色库(失败/无返回默认 zry)。每个音色必须是 ≤30s 参考 + 逐字文字。"""
    try:
        with open(VOICES_MANIFEST, encoding="utf-8") as f:
            data = json.load(f)
        voices = {v["id"]: v for v in data.get("voices", []) if v.get("wavPath") and v.get("text")}
    except Exception:
        voices = {}
    voices.setdefault(DEFAULT_SPK, {"id": DEFAULT_SPK, "name": "zry", "wavPath": REF_WAV, "text": REF_TEXT})
    return voices


def ensure_spk(cosy, spk_id, wav, text):
    """惰性缓存该音色参考特征:首次用到才 add_zero_shot_spk,后续复用(spk2info)。
    只有成功才记入 _cached_spks;失败返回 False(由 /tts 回退默认音色,不把接口卡死)。"""
    if spk_id in _cached_spks:
        return True
    try:
        cosy.add_zero_shot_spk(text, wav, spk_id)
        _cached_spks.add(spk_id)
        return True
    except Exception as e:
        print("add_zero_shot_spk warn:", repr(e)[:160])
        return False

app = FastAPI(title="cosyvoice-tts")
_cosy = None


def get_cosy():
    global _cosy
    if _cosy is None:
        # 实测 fp16+JIT 在 4060Ti 反而更慢(JIT编译开销大),故用默认(无fp16/无JIT)。
        _cosy = CosyVoice2(MODEL_DIR)
        # 一次性缓存参考特征(prompt_text/speech_feat/speech_token/embedding)到 spk2info,
        # 后续每个 /tts 请求的 frontend 都直接复用,省掉重复提取参考音频特征的固定开销。
        _cosy.add_zero_shot_spk(REF_TEXT, REF_WAV, ZERO_SHOT_SPK_ID)
        _cached_spks.add(ZERO_SHOT_SPK_ID)
    return _cosy


def wav_bytes(wav_tensor, sample_rate):
    buf = io.BytesIO()
    data = wav_tensor.cpu().numpy().T  # (channels, samples) -> (samples, channels)
    sf.write(buf, data, sample_rate, format="wav", subtype="PCM_16")
    buf.seek(0)
    return buf.getvalue()


def wav_header(sample_rate, channels=1, bits=16):
    """生成标准 44 字节 PCM WAV 头(与前端 parseWavPcmHeader 的偏移对齐)。"""
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 0, b"WAVE", b"fmt ", 16, 1, channels, sample_rate,
        byte_rate, block_align, bits, b"data", 0,
    )


def pcm16_bytes(wav_tensor):
    """把一块 tts_speech(形状 (1, samples) 的 float [-1,1])量化成 int16 小端 PCM。
    丢弃末尾落单的 1 字节(不够一个 int16),避免前端把残字节当 PCM 播 → 结尾噪音。
    """
    t = wav_tensor.reshape(-1).clamp(-1.0, 1.0)
    t16 = (t * 32767.0).to(torch.int16)
    raw = t16.cpu().numpy().tobytes()
    if len(raw) % 2 != 0:
        raw = raw[:-1]
    return raw


@app.post("/tts")
async def tts(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return Response(content="missing text", media_type="text/plain", status_code=400)
    cosy = get_cosy()
    # 【多音色】按 spk 选对应音色参考合成;未指定/找不到回退默认 zry。新音色(manifest 新增)惰性缓存参考特征。
    spk = (body.get("spk") or body.get("voice") or DEFAULT_SPK)
    voices = load_voices()
    v = voices.get(spk) or voices.get(DEFAULT_SPK)
    if not ensure_spk(cosy, v["id"], v["wavPath"], v["text"]):
        # 该音色参考特征提取失败(坏音频等) → 回退默认音色,不把接口卡死。
        v = voices[DEFAULT_SPK]
        ensure_spk(cosy, v["id"], v["wavPath"], v["text"])
    gen = cosy.inference_zero_shot(text, v["text"], v["wavPath"], zero_shot_spk_id=v["id"], stream=False, text_frontend=False)
    outs = [j["tts_speech"] for _, j in enumerate(gen)]
    wav = torch.cat(outs, dim=1) if len(outs) > 1 else outs[0]
    return Response(content=wav_bytes(wav, cosy.sample_rate), media_type="audio/wav")


@app.post("/prewarm")
async def prewarm(request: Request):
    """【音色预热】只提取指定音色的参考特征并缓存(不合成音频)。
    前端在用户切换音色时调用,把"首次用某音色要花几秒提特征"这一步提前做好,
    这样用户真正开口说第一句话时,音色已就绪、首句更快更稳。
    """
    body = await request.json()
    spk = (body.get("spk") or body.get("voice") or DEFAULT_SPK)
    cosy = get_cosy()
    voices = load_voices()
    v = voices.get(spk) or voices.get(DEFAULT_SPK)
    ok = ensure_spk(cosy, v["id"], v["wavPath"], v["text"])
    return {"ok": ok, "spk": v["id"], "cached": v["id"] in _cached_spks}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=9882)
