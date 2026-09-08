# -*- coding: utf-8 -*-
"""CosyVoice2 TTS HTTP 服务(零样本克隆音色, 本地模型)。

接口兼容: POST /tts {"text": "...", "spk": "..."} → 返回 WAV; POST /prewarm 预热音色。
端口默认 9882。

【真流式】前端 /api/tts?streaming=1 走 /voice/streaming 增量出块: 先发 44 字节 WAV 头,
之后每合成一块 yield 原始 int16 PCM, 前端"边收边播", 首包延迟 ~0.4-0.9s。

【参考音频】CosyVoice 要求参考音频 ≤30s 并有逐字文字稿。默认音色仓库内
voice-samples/ref.wav + ref.txt, 用户可放自己 ≤30s 的音色切片与文字稿, 或用命令行覆盖。

【路径覆盖】可用命令行参数(见文件末尾):
  --repo            CosyVoice 源码目录(含 cosyvoice 包, third_party/Matcha-TTS)
  --model-dir       CosyVoice2 模型目录
  --voices-dir      音色库目录(默认仓库 voice-samples/, 内含 manifest.json + 各音色 wav)
  --ref-wav/--ref-text  默认音色参考(不指定则用 voice-samples/ref.wav + ref.txt)

启动示例:
  python tts_server.py --port 9882 --repo <CosyVoice源码目录> --model-dir <模型目录>
"""
import os, sys, io, struct, json, argparse
sys.stdout.reconfigure(encoding="utf-8")

# 仓库根 = 本文件上两级(backend/tts 上两级是仓库根)
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REPO = os.environ.get("DSH_VOICE_COSY_REPO", "")
MATCHA = os.path.join(REPO, "third_party", "Matcha-TTS") if REPO else ""
for p in (REPO, MATCHA):
    if p and p not in sys.path:
        sys.path.insert(0, p)

import soundfile as sf
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import torch, torchaudio
from cosyvoice.cli.cosyvoice import CosyVoice2

MODEL_DIR = os.path.join(_REPO_ROOT, "models", "CosyVoice2-0.5B")
REF_WAV = os.path.join(_REPO_ROOT, "voice-samples", "ref.wav")
REF_TEXT = ""
VOICES_MANIFEST = os.path.join(_REPO_ROOT, "voice-samples", "manifest.json")
# 缓存参考特征用的零样本 speak id(见文件头注释)。
ZERO_SHOT_SPK_ID = "default"
DEFAULT_SPK = "default"
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
    ap = argparse.ArgumentParser(description="dsh-voice-phone TTS server (CosyVoice2 zero-shot clone)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9882)
    ap.add_argument("--repo", default=REPO, help="CosyVoice 源码目录(含 cosyvoice 包 + third_party/Matcha-TTS)")
    ap.add_argument("--model-dir", default=MODEL_DIR, help="CosyVoice2 模型目录")
    ap.add_argument("--voices-dir", default=os.path.dirname(VOICES_MANIFEST), help="音色库目录(含 manifest.json 和各音色 wav)")
    ap.add_argument("--ref-wav", default=REF_WAV, help="默认音色参考音频 wav (≤30s)")
    ap.add_argument("--ref-text", default=REF_TEXT, help="默认音色参考文字稿")
    args = ap.parse_args()
    # 应用命令行参数到全局(在首次 get_cosy/load_voices 前生效)
    if args.repo:
        REPO = args.repo
        MATCHA = os.path.join(REPO, "third_party", "Matcha-TTS")
        for p in (REPO, MATCHA):
            if p and p not in sys.path:
                sys.path.insert(0, p)
    if args.model_dir:
        MODEL_DIR = args.model_dir
    if args.voices_dir:
        VOICES_MANIFEST = os.path.join(args.voices_dir, "manifest.json")
    if args.ref_wav:
        REF_WAV = args.ref_wav
    if args.ref_text:
        REF_TEXT = args.ref_text
    uvicorn.run(app, host=args.host, port=args.port)
