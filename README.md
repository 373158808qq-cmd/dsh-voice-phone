# dsh-voice-phone-ui-input

**DSH Web 实时语音通话插件** — 在 DeepSeek Harness Web 里开一个"📞 电话会议"：

- 你说话 → 本地语音识别（SenseVoice + Silero VAD）→ Agent 作答
- Agent 回复 → **用你的克隆音色** 实时朗读（CosyVoice2 零样本克隆）
- 支持 **打断**（barge-in）、**静音**（只静音不打断）、**正在说的话**（流式朗读）、**"总结一下"**（只取当前一轮对话的口语总结）
- 全本地、低延迟、免 API Key（也可选云端 API）

> 架构：前端插件（DSH 浏览器端）+ 两个本地 Python 后端服务（识别 9881 / 合成 9882）。后端模型离线可跑，有声卡即可。

---

## 目录结构

```
dsh-voice-phone/
├── backend/
│   ├── stt/stt_server.py    # 语音识别服务 (9881): SenseVoice + Silero VAD
│   └── tts/tts_server.py    # 语音合成服务 (9882): CosyVoice2 零样本克隆
├── scripts/
│   └── download_models.py   # 一键下载模型 (CosyVoice2-0.5B / SenseVoiceSmall / silero-vad)
├── voice-samples/           # 你的音色 (用户自备: ref.wav + ref.txt)
├── models/                  # 模型目录 (下载脚本自动放入)
└── plugin/                  # 前端插件 (DSH 安装用)
```

## 前置要求

- **Python 3.10+**（后端用）
- **NVIDIA GPU**（推荐，识别/合成用 CUDA；无 GPU 可用 CPU，但慢）
- **DSH Web**（插件宿主，见下文安装）
- 网络可访问 HuggingFace 或 ModelScope（下载模型用）

## 安装步骤

### 1. 下载模型

```bash
# 克隆本仓库后
pip install modelscope silero-vad
python scripts/download_models.py            # 默认 ModelScope(国内快)
# 或
python scripts/download_models.py --hub hf  # HuggingFace 源
```

模型会下载到 `models/`：

- `models/CosyVoice2-0.5B/` — TTS 合成（约 900MB）
- `models/SenseVoiceSmall/` — 语音识别（约 1GB）
- `silero-vad` — 人声检测（pip 包，很小）

### 2. 准备 CosyVoice 源码

CosyVoice2 需要其[官方源码仓库](https://github.com/FunAudioLLM/CosyVoice)（含 `cosyvoice` 包和 `third_party/Matcha-TTS`）：

```bash
git clone https://github.com/FunAudioLLM/CosyVoice.git
cd CosyVoice
pip install -r requirements.txt
```

> 启动 TTS 时用 `--repo` 指到这个源码目录。

### 3. 配置你的音色（克隆声音）

在仓库根建 `voice-samples/`：

- `voice-samples/ref.wav` — **你的音色参考音频**（**必须 ≤30 秒**、单人或清晰人声、无噪声）
- `voice-samples/ref.txt` — 对应 wav 里**逐字一致**的文字稿（一行）

> ⚠️ 这是**你的个人音色**，请勿把 wav 上传到公开仓库（仓库的 `.gitignore` 已排除 `voice-samples/`）。

### 4. 启动后端

```bash
# 终端 1: 语音识别 (9881)
python backend/stt/stt_server.py \
  --sensevoice-dir models/SenseVoiceSmall

# 终端 2: 语音合成 (9882)
python backend/tts/tts_server.py \
  --repo <CosyVoice源码目录> \
  --model-dir models/CosyVoice2-0.5B \
  --voices-dir voice-samples
```

验证：

- `curl http://127.0.0.1:9881/health` → `{"ok": true, ...}`
- `POST http://127.0.0.1:9882/tts` 返回 WAV（带音色克隆）

### 5. 安装前端插件

把 `plugin/` 目录（含 `package.json`、`lib/`、`cordis.patch.yml`）放入 DSH 的 `plugins/<你的插件名>/`，然后：

```bash
dsh --profile web --dump-config  # 校验可加载
# 重启 DSH web 后, 刷新页面, 输入框出现 📞 按钮
```

## 使用

- **点 📞** 开电话 → 图标变红，开始听你说
- **说话** → Agent 回答，用你的音色实时朗读
- **开口打断** → 立即停当前朗读，转听你说
- **🔊/🔇** 静音 → 只静音不打断朗读
- **说"总结一下"** → 只把当前这一轮对话总结成口语念出（不写屏、不打断文字生成）

## 常见问题

- **没声音**：确认 9881/9882 都启动、模型下载完整；`--repo` 指向 CosyVoice 源码根目录。
- **音色不像**：参考 wav 需**≤30s**、清晰单声道人声、文字稿逐字一致（CosyVoice 硬性限制）。
- **识别乱码**：说话噪声大时 VAD 可能误判；说慢一点、环境安静些。
- **GPU 不够**：识别可改 `--device cpu`（慢）；合成占用高，与图像/视频任务错开用。

## 许可

MIT（见 `LICENSE`）。模型版权归各自上游（FunAudioLLM / Alibaba iic），按各自许可使用。
