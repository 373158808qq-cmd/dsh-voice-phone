# -*- coding: utf-8 -*-
"""stt_server.py — 独立 whisper STT HTTP 服务 (faster-whisper, GPU)。

供 dsh-voice 宿主插件调用: POST /stt 收音频字节(建议 wav), 返 {"text": "..."}。
- 端口: 9881 (与 GPT-SoVITS 9880 分开)
- 音频解码用 faster_whisper.decode_audio(基于 av, 不需要外部 ffmpeg)
  → 支持 wav / mp3 / webm / opus / flac 等 av 能解的格式
覆盖:
  E:\GPT-SoVITS\.venv\Scripts\python.exe E:\deepseekharness使用\voice\stt_server.py --port 9881
"""
import os, io, json, time, argparse, warnings

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
# 让 FunASR/modelscope 把标点模型缓存到 E 盘(AI 专用目录),避免占用户 C 盘
os.environ["MODELSCOPE_CACHE"] = r"E:\GPT-SoVITS\GPT_SoVITS\pretrained_models\punc_ct-transformer"

warnings.filterwarnings("ignore")

from faster_whisper import decode_audio
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
import uvicorn
import numpy as np
import torch
from silero_vad import load_silero_vad, VADIterator

# SenseVoice 本地快照(轻量、省显存、中文好;已下载,无需联网)
SENSEVOICE_DIR = r"E:\GPT-SoVITS\pretrained_models\models\iic--SenseVoiceSmall\snapshots\master"
# FunASR 中文标点恢复模型(已装到 E 盘)
PUNC_MODEL = "ct-punc"

app = FastAPI(title="dsh-voice STT")
_model = None
_punc = None
_vad = None
_vad_cuda = False
_asr = None


def get_model():
    global _model
    if _model is None:
        from funasr import AutoModel
        # 【SenseVoice】换成轻量 SenseVoice-Small:约1GB显存(比 whisper-large-v3-turbo 省约1.2GB)、
        # 快约2.7x、中文识别质量≥whisper、自带中文标点。本地快照,离线可跑。
        _model = AutoModel(model=SENSEVOICE_DIR, device="cuda:0", disable_update=True,
                           hub="ms", trust_remote_code=True)
    return _model


def get_punc():
    global _punc
    if _punc is None:
        from funasr import AutoModel
        _punc = AutoModel(model=PUNC_MODEL, device="cpu", disable_update=True, model_hub="ms")
    return _punc


def get_vad():
    global _vad, _vad_cuda
    if _vad is None:
        _vad = load_silero_vad()   # 默认 CPU:Silero VAD 很小,CPU 足够;避免与 CTranslate2(whisper)的 CUDA/cuDNN 符号冲突
        _vad_cuda = False
    return _vad


def get_asr():
    """流式中文 ASR:FunASR paraformer-streaming(FD-1 用:边听边出 partial/最终文字,比整段 whisper 快)。"""
    global _asr
    if _asr is None:
        from funasr import AutoModel
        _asr = AutoModel(model="paraformer-zh-streaming", device="cpu", disable_update=True, model_hub="ms")
    return _asr


def transcribe_paraformer(audio):
    """audio: float32 1-D @16kHz -> 用 paraformer-streaming 转写(fast, 中文)。"""
    model = get_asr()
    cache = {}
    text = ""
    n = len(audio)
    for i in range(0, n, 3200):
        chunk = audio[i:i + 3200]
        if len(chunk) < 3200:
            chunk = np.pad(chunk, (0, 3200 - len(chunk))).astype(np.float32)
        is_final = (i + 3200 >= n)
        res = model.generate(input=chunk, cache=cache, is_final=is_final,
                             chunk_size=[0, 10, 5], encoder_chunk_look_back=4, decoder_chunk_look_back=1)
        if res and res[0].get("text"):
            text = res[0]["text"]
    return text.strip()


def strip_sensevoice(text):
    """去掉 SenseVoice 输出里的特殊 token(如 <|zh|> <|SAD|> <|Speech|> <|withitn|> 等),否则文字会带标签。"""
    if not text:
        return ""
    import re
    return re.sub(r"<\|[^>]*\|>", "", text).strip()


def transcribe_audio(audio):
    """audio: float32 numpy 1-D @16kHz -> 转写文字(SenseVoice-Small,自带中文标点)。"""
    m = get_model()
    res = m.generate(input=audio, language="zh", use_itn=True)
    return strip_sensevoice(res[0]["text"] if res else "")


@app.post("/health")
def health():
    return {"ok": True, "name": "dsh-voice-stt", "model": "SenseVoice-Small"}


@app.post("/stt")
async def stt(request: Request):
    body = await request.body()
    if not body:
        return Response(content=json.dumps({"error": "empty body"}, ensure_ascii=False),
                        media_type="application/json", status_code=400)
    # 写成临时 wav 再解码(decode_audio 接受 bytes 也可,这里用内存 io)
    try:
        # decode_audio 接受 bytes? 传 bytes 试试; 若失败则写临时文件
        try:
            audio = decode_audio(io.BytesIO(body))
        except Exception:
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                tf.write(body)
                tmp = tf.name
            try:
                audio = decode_audio(tmp)
            finally:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass
        t0 = time.time()
        # 【SenseVoice】整段转写用 SenseVoice(轻量省显存、快、中文好)。VAD 已在 /voice/stream 做,这里直接转写。
        text = transcribe_audio(audio)
        return Response(content=json.dumps({"text": text, "lang": "zh",
                                           "duration": round(len(audio) / 16000, 2),
                                           "elapsed": round(time.time() - t0, 2)},
                                          ensure_ascii=False),
                        media_type="application/json")
    except Exception as e:
        return Response(content=json.dumps({"error": str(e)}, ensure_ascii=False),
                        media_type="application/json", status_code=500)


@app.websocket("/voice/stream")
async def voice_stream(ws: WebSocket):
    """浏览器持续推 16k 单声道 int16 音频 → Silero VAD 检测语音开始/结束 → EOU 后 whisper STT → 回 {type:'turn', text}。

    EOU(重开宽限):用 min_silence_duration_ms=800 作为"说完了没"的静音阈值——你说完停 >0.8s 才判为结束;
    期间你又开口则继续当前 turn(不截断)。每个 turn 结束时转写并返回。
    """
    await ws.accept()
    try:
        vad_model = get_vad()
        vad = VADIterator(
            vad_model,
            sampling_rate=16000,
            threshold=0.5,
            min_silence_duration_ms=800,
            speech_pad_ms=200,
        )
        in_speech = False
        buf = []
        while True:
            data = await ws.receive_bytes()
            arr = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            for i in range(0, len(arr), 512):
                chunk = arr[i:i + 512]
                if len(chunk) < 512:
                    chunk = np.pad(chunk, (0, 512 - len(chunk))).astype(np.float32)
                chunk_t = torch.from_numpy(chunk)
                if _vad_cuda:
                    chunk_t = chunk_t.cuda()
                res = vad(chunk_t, return_seconds=True)
                if in_speech:
                    buf.append(chunk)
                if res:
                    if "start" in res:
                        if not in_speech:
                            in_speech = True
                            buf = [chunk]
                            # 【barge-in】检测到用户"开始说话"就立刻通知前端:立即停掉 agent 朗读/生成。
                            # 不等你说完(那样会整句重叠)。前端收到后马上打断。
                            await ws.send_json({"type": "speech_start"})
                    if "end" in res:
                        in_speech = False
                        if buf:
                            audio = np.concatenate(buf)
                            # 【回退】turn 转写仍用可靠 whisper(paraformer-streaming 转写 turn 段暂不稳,先不换);
                            # paraformer 只作"边听边出 partial"(FD-2)用,已留 get_asr/transcribe_paraformer 备用。
                            text = transcribe_audio(audio)
                            await ws.send_json({"type": "turn", "text": text})
                        buf = []
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print("voice/stream error:", repr(e)[:200])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9881)
    args = ap.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
