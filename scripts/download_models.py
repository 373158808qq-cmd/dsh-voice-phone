# -*- coding: utf-8 -*-
"""download_models.py — 自动下载 dsh-voice-phone 后端所需的模型。

下载到仓库根 models/ 目录(与 tts_server/stt_server 的默认路径一致):
  models/CosyVoice2-0.5B/     CosyVoice2-0.5B TTS 模型(约 900MB)
  models/SenseVoiceSmall/     SenseVoiceSmall STT 模型(约 1GB)
  models/Matcha-TTS/          CosyVoice 依赖的 Matcha-TTS(若 CosyVoice 源码尚未含)

用法:
  python scripts/download_models.py            # 默认从 modelscope 下载(国内快)
  python scripts/download_models.py --hub hf   # 改从 HuggingFace 下载

前置依赖: pip install modelscope 或 pip install huggingface_hub
"""
import os, sys, argparse, shutil

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(_REPO_ROOT, "models")


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


def dl_modelscope(model_id, target_dir):
    """用 modelscope 下载(国内快,自动处理重试)。"""
    try:
        from modelscope import snapshot_download
    except ImportError:
        print(f"[ERROR] 未安装 modelscope。请先: pip install modelscope")
        return False
    print(f"[1/3] 从 modelscope 下载 {model_id} ...")
    try:
        cache_dir = snapshot_download(model_id, cache_dir=MODELS_DIR)
        # modelscope 会把模型放到 MODELS_DIR/<model_id>/snapshots/master
        dest = os.path.join(MODELS_DIR, model_id)
        if cache_dir and os.path.isdir(cache_dir) and os.path.abspath(cache_dir) != os.path.abspath(target_dir):
            # 链接到统一目录,方便 tts_server/stt_server 按固定路径找
            if os.path.isdir(target_dir) and os.listdir(target_dir):
                print(f"    目标目录已存在,跳过: {target_dir}")
                return True
            shutil.copytree(cache_dir, target_dir, dirs_exist_ok=True)
        print(f"    完成 → {target_dir}")
        return True
    except Exception as e:
        print(f"[ERROR] modelscope 下载失败: {e}")
        return False


def dl_huggingface(model_id, target_dir):
    """用 huggingface_hub 下载(海外/镜像)。"""
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print(f"[ERROR] 未安装 huggingface_hub。请先: pip install huggingface_hub")
        return False
    print(f"[1/3] 从 HuggingFace 下载 {model_id} ...")
    try:
        path = snapshot_download(model_id, local_dir=target_dir)
        print(f"    完成 → {path}")
        return True
    except Exception as e:
        print(f"[ERROR] huggingface 下载失败: {e}")
        return False


def main():
    ap = argparse.ArgumentParser(description="下载 dsh-voice-phone 模型")
    ap.add_argument("--hub", choices=["ms", "hf"], default="ms",
                    help="下载源: ms=modelscope(国内快, 默认), hf=HuggingFace")
    ap.add_argument("--models-dir", default=MODELS_DIR, help="模型存放根目录(默认: 仓库 models/)")
    args = ap.parse_args()

    models_dir = ensure_dir(args.models_dir)
    print(f"模型将下载到: {models_dir}\n")

    # 1. CosyVoice2-0.5B (TTS 合成)
    ok_cosy = dl_modelscope("iic/CosyVoice2-0.5B", os.path.join(models_dir, "CosyVoice2-0.5B")) \
        if args.hub == "ms" else \
        dl_huggingface("FunAudioLLM/CosyVoice2-0.5B", os.path.join(models_dir, "CosyVoice2-0.5B"))

    # 2. SenseVoiceSmall (STT 识别)
    ok_sense = dl_modelscope("iic/SenseVoiceSmall", os.path.join(models_dir, "SenseVoiceSmall")) \
        if args.hub == "ms" else \
        dl_huggingface("FunAudioLLM/SenseVoiceSmall", os.path.join(models_dir, "SenseVoiceSmall"))

    # 3. Silero VAD (pip 包, 很小)
    print("[3/3] 检查 silero-vad (pip 包)...")
    ok_vad = True
    try:
        import silero_vad  # noqa: F401
        print("    silero-vad 已安装")
    except ImportError:
        print("    未安装, 尝试 pip install silero-vad ...")
        import subprocess, sys as _sys
        r = subprocess.run([_sys.executable, "-m", "pip", "install", "silero-vad"],
                           capture_output=True, text=True)
        ok_vad = (r.returncode == 0)
        print("    安装成功" if ok_vad else f"    安装失败: {r.stderr[-200:]}")

    print("\n==== 下载结果 ====")
    print(f"CosyVoice2-0.5B  : {'OK' if ok_cosy else '失败(请手动重试)'}")
    print(f"SenseVoiceSmall  : {'OK' if ok_sense else '失败(请手动重试)'}")
    print(f"Silero VAD       : {'OK' if ok_vad else '失败(请手动重试)'}")
    if not (ok_cosy and ok_sense and ok_vad):
        print("\n提示: 模型没下全时, 可重跑本脚本(--hub hf 换源), 或按 README 手动下载。")
        sys.exit(1)
    print("\n全部就绪! 下一步见 README: 配置音色 + 启动后端。")


if __name__ == "__main__":
    main()
