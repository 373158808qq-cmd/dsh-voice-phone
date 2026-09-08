//#region lib/types/index.js
/**
* Host half of the voice-input client plugin — no host-side behavior. The
* browser half (`src/client/index.ts`) registers the composer mic control.
* @module @deepseek-ai/dsh-client-ui-voice-input
*/
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import os from "node:os";
import net from "node:net";
import { execFile, spawn } from "node:child_process";

// 本宿主插件需要 webServer 服务来注册只读检测接口（/voice/devices、/voice/models）。
// 声明 inject 后 apply(ctx) 才能访问 ctx.webServer；webServer 由宿主 web 插件提供（dsh-voice 已在用）。
export const inject = ["webServer"];

// ---- 只读检测辅助（失败安全：检测不到一律返回安全默认，绝不向外抛） ----
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function listDirs(root) {
	try {
		if (!dirExists(root)) return [];
		return fs.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(root, d.name));
	} catch { return []; }
}
function existsAny(dir, names) { return names.some((n) => fileExists(path.join(dir, n))); }

// 真实检测 NVIDIA 卡：nvidia-smi 读 index/name/memory。无卡或命令失败仍返回 ["auto","cpu"]。
// cpuName 取本机 CPU 型号（os.cpus）供设置页显示真实 CPU 名称。
function detectDevices() {
	return new Promise((resolve) => {
		let cpuName = "";
		try { cpuName = String(os.cpus()[0]?.model || "").replace(/\s+/g, " ").trim(); } catch { cpuName = ""; }
		const done = (r) => resolve(Object.assign({ devices: ["auto", "cpu"], gpus: [], cpuName, error: null, raw: "", rawL: "" }, r));
		execFile("nvidia-smi", ["--query-gpu=index,name,memory.total", "--format=csv,noheader"], { timeout: 8000, windowsHide: true }, (err, stdout) => {
			const so = (!err && stdout) ? String(stdout) : "";
			const gpuMap = new Map();
			for (const line of so.split(/\r?\n/)) {
				// 兼容带引号的 name 列(不同版本 nvidia-smi 输出差异):去掉首尾引号。
				const cols = line.trim().split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
				const idx = Number(cols[0]);
				if (!Number.isFinite(idx)) continue;
				gpuMap.set(idx, { index: idx, name: cols[1] || "", memory: cols[2] || "" });
			}
			// 【兜底】csv 解析不出显卡名(版本/字段差异)时,用 nvidia-smi -L 再补一次:
			// 输出形如 "GPU 0: NVIDIA GeForce RTX 4060 Ti (UUID: ...)"。
			const finish = (rawL) => {
				const indices = [...gpuMap.keys()].sort((a, b) => a - b);
				done({ devices: ["auto", ...indices.map((i) => "gpu:" + i), "cpu"], gpus: indices.map((i) => gpuMap.get(i)), error: null, raw: so, rawL: rawL || "" });
			};
			if (gpuMap.size === 0 || [...gpuMap.values()].some((g) => !g.name)) {
				execFile("nvidia-smi", ["-L"], { timeout: 8000, windowsHide: true }, (e2, so2) => {
					const rawL = (!e2 && so2) ? String(so2) : "";
					for (const line of rawL.split(/\r?\n/)) {
						const m = /^GPU\s+(\d+):\s+(.+?)\s*\(/.exec(line.trim());
						if (!m) continue;
						const idx = Number(m[1]);
						if (!gpuMap.has(idx)) gpuMap.set(idx, { index: idx, name: m[2].trim(), memory: "" });
						else if (!gpuMap.get(idx).name) gpuMap.get(idx).name = m[2].trim();
					}
					finish(rawL);
				});
			} else {
				finish("");
			}
		});
	});
}

// 已知模型家族：目录存在 + 关键配置即视为已安装。probe 是相对 modelDir 的文件名。
const MODEL_FAMILIES = [
	{ id: "cosyvoice-local", kind: "tts", label: "CosyVoice2", root: "E:/CosyVoice/pretrained_models/models", prefix: /iic--CosyVoice/i, probe: ["cosyvoice2.yaml", "llm.pt"] },
	{ id: "sensevoice-local", kind: "stt", label: "SenseVoice", root: "E:/GPT-SoVITS/pretrained_models/models", prefix: /iic--SenseVoice/i, probe: ["config.yaml", "model.pt"] },
	{ id: "whisper-local", kind: "stt", label: "whisper", root: "E:/GPT-SoVITS/tools/asr/models", prefix: null, probe: ["model.bin", "config.json"] },
];

// 扫描一个家族：在 root 下找子目录，命中前缀（非 whisper）时优先看 snapshots/master。
function scanFamily(fam) {
	for (const dir of listDirs(fam.root)) {
		const base = path.basename(dir);
		if (fam.prefix && !fam.prefix.test(base)) continue;
		let modelDir = dir;
		if (fam.prefix) { // CosyVoice/SenseVoice 模型在 snapshots/master
			const snap = path.join(dir, "snapshots", "master");
			if (dirExists(snap)) modelDir = snap;
		}
		if (existsAny(modelDir, fam.probe)) return { available: true, path: modelDir, detail: "已就绪" };
	}
	return { available: false, path: "", detail: "未检测到" };
}

// 本机模型扫描，返回每家族可用状态 + 方便前端选值的可用 id 列表。
function detectModels() {
	const results = MODEL_FAMILIES.map((fam) => Object.assign({ id: fam.id, kind: fam.kind, label: fam.label }, scanFamily(fam)));
	return {
		ok: true,
		error: null,
		models: results,
		ttsAvailable: results.filter((m) => m.kind === "tts" && m.available).map((m) => m.id),
		sttAvailable: results.filter((m) => m.kind === "stt" && m.available).map((m) => m.id),
	};
}

// ---- 【模型开关】本地引擎 = 启停语音服务进程(9881 STT / 9882 TTS)。 ----
// start: spawn 服务进程(挂在本插件进程下;web 重启即随 web 结束);stop: 先杀托管进程,
// 再按端口兜底杀(覆盖 venvlauncher 的子进程/用户手动拉起的进程),保证"停了就是停了"。
const ENGINE_PORTS = { stt: 9881, tts: 9882 };
const ENGINE_CMDS = {
	stt: {
		py: "E:/GPT-SoVITS/.venv/Scripts/python.exe",
		args: ["E:/deepseekharness使用/voice/stt_server.py", "--port", "9881"],
	},
	tts: {
		py: "E:/CosyVoice/.venv/Scripts/python.exe",
		args: ["E:/CosyVoice/tts_server.py"],
	},
};
const managedProcs = {};
// TCP 探测某端口是否有服务在监听(1.2s 超时)。
function probePort(port) {
	return new Promise((resolve) => {
		const s = net.connect({ port, host: "127.0.0.1" });
		const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
		s.on("connect", () => done(true));
		s.on("error", () => done(false));
		s.setTimeout(1200, () => done(false));
	});
}
// 按端口找监听进程并强杀(netstat -ano → taskkill /F /T)。
function killByPort(port) {
	return new Promise((resolve) => {
		execFile("netstat", ["-ano"], { timeout: 10000, windowsHide: true }, (err, stdout) => {
			if (err || !stdout) { resolve(false); return; }
			const re = new RegExp(":" + port + "\\s+\\S+\\s+LISTENING\\s+(\\d+)", "i");
			const m = String(stdout).match(re);
			const pid = m ? Number(m[1]) : 0;
			if (!pid || pid <= 4) { resolve(false); return; }
			execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 10000, windowsHide: true }, () => resolve(true));
		});
	});
}
// 构造一段静音 wav(供 STT 预热——模型懒加载,首次调用才真正进显存)。
function makeSilentWav(sr, secs) {
	const n = Math.max(1, Math.floor(sr * (secs || 0.3)));
	const dataLen = n * 2;
	const b = Buffer.alloc(44 + dataLen);
	b.write("RIFF", 0, "ascii");
	b.writeUInt32LE(36 + dataLen, 4);
	b.write("WAVE", 8, "ascii");
	b.write("fmt ", 12, "ascii");
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(sr, 24);
	b.writeUInt32LE(sr * 2, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write("data", 36, "ascii");
	b.writeUInt32LE(dataLen, 40);
	return b;
}
// 预热引擎:首次调用把懒加载模型真正载入显存(成功后引擎才算"真就绪")。
async function prewarmEngine(id) {
	const ac = new AbortController();
	const tm = setTimeout(() => ac.abort(), 90000);
	try {
		if (id === "stt") {
			await fetch("http://127.0.0.1:9881/stt", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: makeSilentWav(16000, 0.3), signal: ac.signal });
		} else {
			await fetch("http://127.0.0.1:9882/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "预热测试。" }), signal: ac.signal });
		}
		return true;
	} catch (e) {
		try { console.warn("[voice-engine] prewarm " + id + " failed: " + String((e && e.message) || e)); } catch {}
		return false;
	} finally {
		clearTimeout(tm);
	}
}

// ---- 音色文件目录：插件根目录/runtime/voices/<id>/ ----
// 用 fileURLToPath(import.meta.url) 取 lib 目录，再回退一级到插件根；runtime 目录可写。
// 【统一路径】必须放插件根 runtime/（而非 lib/runtime/）：tts_server(9882) 的 VOICES_MANIFEST
// 读的就是 插件根/runtime/voices/manifest.json，两侧不一致会导致"切音色永远读不到"。
const __pluginDir = path.dirname(url.fileURLToPath(import.meta.url));
const VOICE_RUNTIME_ROOT = path.join(__pluginDir, "..", "runtime", "voices");
const MAX_VOICES = 5;
const VOICE_MAX_BYTES = 30 * 1024 * 1024; // 前端按 ≤30s 校验；后端先按 30MB 防空传/超大
// GPT-SoVITS 虚拟环境里的 python（已装 av=PyAV 可解 wav/mp3/webm/opus + soundfile/numpy），
// 用于"裁出最清晰 ≤5s 段"。不用 CosyVoice venv——它缺 av，librosa.load 在本机还会挂。
const TRIM_PY = "E:/GPT-SoVITS/.venv/Scripts/python.exe";

// settings 服务句柄：由 apply 内 ctx.inject(["settings"]) 填充。拿不到(未挂载 settings 服务)
// 时，音色入库/删除返回安全错误，绝不向外抛/不触碰已验证功能。
let voiceSettings = { svc: null, ns: "voice-input", ready: false };

function readVoiceList() {
	if (!voiceSettings.ready || !voiceSettings.svc) return [];
	try {
		const cur = voiceSettings.svc.get(voiceSettings.ns) || {};
		return Array.isArray(cur.voices) ? cur.voices.slice() : [];
	} catch { return []; }
}
async function writeVoiceList(newList, selectedId) {
	if (!voiceSettings.ready || !voiceSettings.svc) throw new Error("settings service unavailable");
	const patch = { voices: newList };
	if (selectedId !== void 0) patch.selectedVoiceId = selectedId;
	await voiceSettings.svc.update(voiceSettings.ns, patch);
	return patch;
}
// ---- 音色 manifest：tts_server(9882)每次 /tts 读取 runtime/voices/manifest.json 以支持"切音色即刻生效"。
// 与 settings.voices 保持同步：commit/delete 都重写整份清单(失败安全：失败仅记日志，不阻断入库/删除)。
const VOICE_MANIFEST_PATH = path.join(VOICE_RUNTIME_ROOT, "manifest.json");
function writeVoiceManifest(list) {
	const payload = {
		version: 1,
		updatedAt: new Date().toISOString(),
		voices: list.map((v) => ({
			id: String(v.id || ""),
			name: String(v.name || ""),
			wavPath: String(v.wavPath || ""),
			text: String(v.text || "")
		}))
	};
	fs.mkdirSync(VOICE_RUNTIME_ROOT, { recursive: true });
	fs.writeFileSync(VOICE_MANIFEST_PATH, JSON.stringify(payload, null, 2), "utf8");
}
// 统一 JSON 响应（失败安全：写头/端都不向外抛）。
function jsonResponse(res, code, obj) {
	try {
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(obj));
	} catch { /* ignore */ }
}
// 读取请求体为 Buffer（带 body 大小上限，超出即拒绝并销毁）。
function readBodyBuffer(req, limit) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (limit && size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
// 从 multipart/form-data 里尽力抽出第一段二进制文件(binary 字符串往返是字节无损的)。
async function extractMultipartFile(req) {
	const buf = await readBodyBuffer(req, VOICE_MAX_BYTES + 64 * 1024);
	const ctype = String(req.headers["content-type"] || "");
	const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
	if (!m) return null;
	const boundary = "--" + (m[1] || m[2]).trim();
	for (const part of buf.toString("binary").split(boundary)) {
		if (part.includes("filename=") && part.includes("\r\n\r\n")) {
			const sep = part.indexOf("\r\n\r\n");
			const data = part.slice(sep + 4).replace(/\r\n$/, "");
			return Buffer.from(data, "binary");
		}
	}
	return null;
}

// 【裁剪】用 GPT-SoVITS python + PyAV 解码(兼容 wav/mp3/webm/opus) → numpy 找"音量最大的连续 ≤5 秒"段。
// 另存 seg.wav(PCM16)。若 av 不可用/解码失败，回退到 soundfile；都失败则交给兜底复制。
function runTrimPython(rawPath, segPath, secs) {
	const script = [
		"import sys, numpy as np",
		"src, dst = sys.argv[1], sys.argv[2]",
		"sec = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0",
		"decoded = None; sr = 0",
		"try:",
		"    import av",
		"    c = av.open(src)",
		"    st = c.streams.audio[0]",
		"    sr = st.codec_context.sample_rate or 16000",
		"    frames = []",
		"    for frame in c.decode(st):",
		"        a = frame.to_ndarray()",
		"        ok = a.dtype.kind; ob = a.dtype.itemsize",
		"        # 【声道·关键】PyAV packed 格式(如 s16 立体声)的 to_ndarray() 返回单平面【交错】数据:",
		"        # 帧 samples=4096/ch=2 → shape=(1, 8192)。若把交错样本当时间轴拼接,",
		"        # 左右声道样本重复成序列(每样本×2)→ 播放时长翻倍+降调,听感=‘降速’(本次实测踩坑)。",
		"        # 正确做法:按 (samples, channels) 解交错 → 按声道平均成 mono;planar (ch, samples) 转置同法。",
		"        chn = st.codec_context.channels",
		"        samp = frame.samples",
		"        if a.size == samp * chn:",
		"            a = a.reshape(samp, chn)",
		"        elif a.ndim == 2 and a.shape[0] == chn and a.shape[1] == samp:",
		"            a = a.T",
		"        if a.ndim == 2:",
		"            a = a.mean(axis=1)",
		"        # 【归一化·关键】整数(s16±32767/u8 0~255)必须转 [-1,1] 浮点,否则 sf.write(PCM_16) 全饱和=噪音。",
		"        # 注意 mean() 会把 int16 升成 float64，所以按上面保存的原始 ok/ob 判断。",
		"        if ok == 'f':",
		"            a = a.astype(np.float32)",
		"        else:",
		"            bits = ob * 8",
		"            half = float(2 ** (bits - 1))",
		"            off = 0.0 if ok == 'i' else half",
		"            a = ((a.astype(np.float64) - off) / half).astype(np.float32)",
		"        frames.append(a.reshape(-1))",
		"    if frames: decoded = np.concatenate(frames)",
		"except Exception:",
		"    pass",
		"if decoded is None:",
		"    import soundfile as sf",
		"    d, sr = sf.read(src, dtype='float32', always_2d=True)",
		"    decoded = d.mean(axis=1) if d.ndim > 1 and d.shape[1] > 1 else d.ravel()",
		"y = decoded.astype(np.float64)",
		"n = len(y); frame = int(round(sec * sr))",
		"if n <= frame: seg = y.astype(np.float32)",
		"else:",
		"    flen = 1024; hop = 256",
		"    if n < flen: flen = n; hop = max(1, n // 10)",
		"    nf = max(1, (n - flen) // hop + 1)",
		"    rms = np.empty(nf)",
		"    for i in range(nf):",
		"        w = y[i*hop:i*hop+flen]",
		"        rms[i] = np.sqrt(np.mean(w*w)) if w.size else 0.0",
		"    win = max(1, int(frame // hop))",
		"    if win >= nf: win = nf",
		"    cs = np.concatenate(([0.0], np.cumsum(rms)))",
		"    best = -1.0; bestStart = 0",
		"    for i in range(0, nf - win + 1):",
		"        s = cs[i+win] - cs[i]",
		"        if s > best: best = s; bestStart = i",
		"    start = bestStart * hop",
		"    end = min(n, start + frame)",
		"    start = max(0, end - frame)",
		"    seg = y[start:end].astype(np.float32)",
		"import soundfile as sf",
		"sf.write(dst, seg, sr, subtype='PCM_16')",
		"print(len(seg) / sr)",
	].join("\n");
	return new Promise((resolve, reject) => {
		execFile(TRIM_PY, ["-c", script, rawPath, segPath, String(secs)], { timeout: 90000, windowsHide: true }, (err, stdout, stderr) => {
			if (err) { reject(new Error(String((stderr && stderr.trim()) || err.message || err))); return; }
			resolve(String(stdout || "").trim());
		});
	});
}
function trimToLoudest5s(rawPath, segPath) {
	if (fs.existsSync(TRIM_PY)) {
		return runTrimPython(rawPath, segPath, 5).then(() => segPath).catch((e) => {
			ctx_console_warn("[dsh-client-ui-voice-input] trim python failed; copying raw instead: " + String((e && e.message) || e));
			try { fs.copyFileSync(rawPath, segPath); } catch { /* ignore */ }
			return segPath;
		});
	}
	ctx_console_warn("[dsh-client-ui-voice-input] trim python not found; copying raw");
	try { fs.copyFileSync(rawPath, segPath); } catch { /* ignore */ }
	return Promise.resolve(segPath);
}
function ctx_console_warn(msg) { try { console.warn(msg); } catch { /* ignore */ } }
// 【识别】调 9881 /stt(收 wav 字节,返 {"text":...})。
async function recognizeAudio(wavPath) {
	const seg = fs.readFileSync(wavPath);
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 30000);
	try {
		const resp = await fetch("http://127.0.0.1:9881/stt", {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: seg,
			signal: ac.signal,
		});
		const j = await resp.json().catch(() => ({}));
		return typeof j.text === "string" ? j.text : "";
	} finally {
		clearTimeout(timer);
	}
}

/** Host plugin body: browser-surface feature + 只读检测接口。 */
async function apply(ctx, config = {}) {
	// 设置页宿主侧需要在<dshHome>/settings.yaml 的 `voice-input` 命名空间注册。
	// 依赖 schemastery + dsh-settings 须按插件惯例装到 <plugin>/node_modules；
	// 这里用【动态 import + try/catch】——哪怕依赖没装上，也绝不抛错/让模块加载失败，
	// 因为那会把已验证的📞通话/话筒前端一起打崩。依赖可用时注册，不可用时静默跳过。
	try {
		const zMod = await import("@deepseek-ai/schemastery");
		const settingsMod = await import("@deepseek-ai/dsh-settings");
		const z = zMod.default;
		const { installSettingsSection, settingsNamespace } = settingsMod;
		const NS = settingsNamespace("voice-input");
		const VoiceRef = z.object({
			/** 音色唯一 id。 */
			id: z.string().default(""),
			/** 显示名称（用户可读）。 */
			name: z.string().default(""),
			/** 合成用参考音频绝对路径（runtime/voices/<id>/seg.wav）。 */
			wavPath: z.string().default(""),
			/** 参考音频对应的文字稿（作为 prompt_text）。 */
			text: z.string().default("")
		});
		const Config = z.object({
			/** 引擎模式：local=本地推理，api=云端 API。 */
			engineMode: z.union(["local", "api"]).default("local"),
			/** 麦克风设备 ID（空=系统默认）。 */
			deviceId: z.string().default(""),
			/** 云端 API Key（secret 脱敏，不会回显真实值）。 */
			apiKey: z.string().role("secret").default(""),
			/** 云端 STT(识别) API Key：可填独立 Key，或与 TTS 同家共用填同一个。 */
			sttApiKey: z.string().role("secret").default(""),
			/** 云端 TTS(合成) API Key：可填独立 Key，或与 STT 同家共用填同一个。 */
			ttsApiKey: z.string().role("secret").default(""),
			/** TTS 模型。 */
			ttsModel: z.string().default(""),
			/** STT 模型。 */
			sttModel: z.string().default(""),
			/** LLM 档位：auto=自动，fast=快答，deep=深思。 */
			llmEffort: z.string().default("auto"),
			/** 音色参考音频路径。 */
			refAudioPath: z.string().default(""),
			/** 音色参考文本。 */
			promptText: z.string().default(""),
			/** 已训练音色列表（≤5）。 */
			voices: z.array(VoiceRef).default([]),
			/** 当前选中音色 id。 */
			selectedVoiceId: z.string().default("")
		});
		// 在宿主注册 settings 命名空间，浏览器端 settingsScope.bind({namespace:"voice-input"})
		// 才能读到 status:"ready"（否则 unavailable）。本插件宿主不消费这些值，仅需要命名空间存在，
		// 因此 setSource/onChange 设为 no-op（官方要求这两个钩子必须存在，否则 installSettingsSection 会抛错）。
		installSettingsSection(ctx, NS, Config, config ?? {}, {
			setSource: () => {},
			onChange: () => {}
		});
		// 捕获 settings 服务句柄，供 commit/delete 写 voices（失败安全：拿不到则入库/删除返回错误）。
		ctx.inject(["settings"], (sctx) => {
			voiceSettings.svc = sctx.settings;
			voiceSettings.ns = NS;
			voiceSettings.ready = true;
		});
	} catch (error) {
		console.warn("[dsh-voice] settings section skipped (deps unavailable):", error?.message);
	}

	// 【真实设备/模型检测】只读接口。纯新增，不触碰已验证的📞通话/打断/挂断/档位/非流式逻辑。
	// webServer 未就绪时静默跳过（不抛错），保证设置页照常可用。
	try {
		if (ctx && ctx.webServer && typeof ctx.webServer.register === "function") {
			// 真实显卡列表：nvidia-smi 读卡。失败也返回安全列表 ["auto","cpu"] + error 字段。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/devices",
				handler: async (req, res) => {
					try {
						const r = await detectDevices();
						res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
						res.end(JSON.stringify(r));
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/devices error ${err?.message ?? err}`);
						if (!res.headersSent) {
							res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
							res.end(JSON.stringify({ devices: ["auto", "cpu"], gpus: [], error: String(err?.message || err) }));
						} else {
							res.end();
						}
					}
				},
			}), "dsh-client-ui-voice-input: /voice/devices");

			// 本机模型扫描：CosyVoice / SenseVoice / whisper 目录是否含配置。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/models",
				handler: async (req, res) => {
					try {
						const r = detectModels();
						res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
						res.end(JSON.stringify(r));
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/models error ${err?.message ?? err}`);
						if (!res.headersSent) {
							res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
							res.end(JSON.stringify({ ok: false, error: String(err?.message || err), models: [], ttsAvailable: [], sttAvailable: [] }));
						} else {
							res.end();
						}
					}
				},
			}), "dsh-client-ui-voice-input: /voice/models");

			// 【模型开关】状态查询：探测 9881/9882 端口 + 是否本插件托管的进程。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/models/status",
				handler: async (req, res) => {
					try {
						const engines = {};
						for (const id of Object.keys(ENGINE_PORTS)) {
							engines[id] = { running: await probePort(ENGINE_PORTS[id]), managed: !!managedProcs[id] };
						}
						jsonResponse(res, 200, { ok: true, engines });
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/models/status ${err?.message ?? err}`);
						jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/models/status");

			// 【模型开关】start/stop 引擎进程(id=stt|tts)。start 幂等(已监听则直接 ok)；
			// stop 先杀托管进程、再按端口兜底杀，保证"停了就是停了"。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/models/control",
				handler: async (req, res) => {
					try {
						const body = await parseJson(req);
						const id = String(body.id || "");
						const action = String(body.action || "");
						if (!ENGINE_PORTS[id]) { jsonResponse(res, 400, { ok: false, error: "unknown engine: " + id }); return; }
						const port = ENGINE_PORTS[id];
						if (action === "start") {
							if (await probePort(port)) { jsonResponse(res, 200, { ok: true, engine: id, running: true, note: "已在运行" }); return; }
							const cfg = ENGINE_CMDS[id];
							try {
								const proc = spawn(cfg.py, cfg.args, { windowsHide: true, cwd: path.dirname(cfg.py), stdio: ["ignore", "pipe", "pipe"] });
								managedProcs[id] = proc;
								const log = (d) => { try { const s = String(d).trim(); if (s) ctx.logger?.info?.("[voice-engine " + id + "] " + s); } catch {} };
								if (proc.stdout) proc.stdout.on("data", log);
								if (proc.stderr) proc.stderr.on("data", log);
								proc.on("exit", () => { if (managedProcs[id] === proc) managedProcs[id] = null; });
								// 【懒加载】进程起来只监听端口,模型要首次调用才进显存 → 这里等端口就绪 + 预热,
								// 让"启动"按钮真正把模型拉起来(否则点启动后 10 秒内既没显存又不可用,误以为没启动)。
								let ready = false;
								const dl = Date.now() + 25000;
								while (Date.now() < dl && !(await probePort(port))) { await new Promise((r) => setTimeout(r, 500)); }
								if (await probePort(port)) ready = await prewarmEngine(id);
								jsonResponse(res, 200, { ok: true, engine: id, running: ready, ready, note: ready ? "已启动并加载好模型" : "进程已启动，模型预热失败（首次调用可能较慢）" });
							} catch (err) {
								jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
							}
							return;
						}
						if (action === "stop") {
							const proc = managedProcs[id];
							if (proc) { try { proc.kill(); } catch {} managedProcs[id] = null; }
							try { await killByPort(port); } catch {}
							jsonResponse(res, 200, { ok: true, engine: id, running: false });
							return;
						}
						jsonResponse(res, 400, { ok: false, error: "bad action: " + action });
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/models/control ${err?.message ?? err}`);
						jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/models/control");

			// 【音色管理】上传→裁剪≤5s→识别→(前端确认)→入库；删除。全部失败安全，只处理音色，不动通话。
			// 解析 JSON 请求体。
			const parseJson = async (req) => {
				const raw = (await readBodyBuffer(req, 128 * 1024)).toString("utf8");
				if (!raw) return {};
				try { return JSON.parse(raw); } catch { return {}; }
			};

			// 上传：收 octet-stream / multipart 音频字节，存 runtime/voices/<id>/raw.wav。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/voices/upload",
				handler: async (req, res) => {
					try {
						if (req.method !== "POST") { jsonResponse(res, 405, { ok: false, error: "method not allowed" }); return; }
						const ctype = String(req.headers["content-type"] || "");
						let audio = null;
						if (ctype.includes("multipart/form-data")) {
							audio = await extractMultipartFile(req);
						} else {
							audio = await readBodyBuffer(req, VOICE_MAX_BYTES + 1024);
						}
						if (!audio || audio.length === 0) { jsonResponse(res, 400, { ok: false, error: "empty body" }); return; }
						if (audio.length > VOICE_MAX_BYTES) { jsonResponse(res, 400, { ok: false, error: "audio too large (>30s)" }); return; }
						const id = "v_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
						const dir = path.join(VOICE_RUNTIME_ROOT, id);
						fs.mkdirSync(dir, { recursive: true });
						const rawPath = path.join(dir, "raw.wav");
						fs.writeFileSync(rawPath, audio);
						jsonResponse(res, 200, { ok: true, id, rawPath });
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/voices/upload ${err?.message ?? err}`);
						jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/voices/upload");

			// 裁剪 + 识别：裁出最清晰 ≤5s 存 seg.wav，再调 9881 /stt 识别文字给用户确认。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/voices/trim",
				handler: async (req, res) => {
					try {
						const body = await parseJson(req);
						const id = String(body.id || "");
						if (!id) { jsonResponse(res, 400, { ok: false, error: "missing id" }); return; }
						const dir = path.join(VOICE_RUNTIME_ROOT, id);
						const rawPath = path.join(dir, "raw.wav");
						const segPath = path.join(dir, "seg.wav");
						if (!fs.existsSync(rawPath)) { jsonResponse(res, 400, { ok: false, error: "raw.wav not found; upload first" }); return; }
						await trimToLoudest5s(rawPath, segPath);
						let text = "";
						try { text = await recognizeAudio(segPath); }
						catch (e) { ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/voices/trim stt ${e?.message ?? e}`); }
						jsonResponse(res, 200, { ok: true, id, segPath, text });
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/voices/trim ${err?.message ?? err}`);
						jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/voices/trim");

			// 入库：把 {id, name, wavPath: segPath, text} 写入 settings voices（≤5）；满则报错。默认选中新音色。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/voices/commit",
				handler: async (req, res) => {
					try {
						const body = await parseJson(req);
						const id = String(body.id || "");
						const name = String(body.name || "").trim();
						const text = String(body.text || "").trim();
						if (!id) { jsonResponse(res, 400, { ok: false, error: "missing id" }); return; }
						const segPath = path.join(VOICE_RUNTIME_ROOT, id, "seg.wav");
						if (!fs.existsSync(segPath)) { jsonResponse(res, 400, { ok: false, error: "seg.wav not found; trim first" }); return; }
						const list = readVoiceList();
						if (list.length >= MAX_VOICES) { jsonResponse(res, 400, { ok: false, error: "已满，请先删除一个音色", code: "voices_full" }); return; }
						if (list.some((v) => v.id === id)) { jsonResponse(res, 409, { ok: false, error: "音色已存在" }); return; }
						const entry = { id, name: name || id, wavPath: segPath, text };
						const newList = list.concat([entry]);
						await writeVoiceList(newList, id);
						// 【音色manifest】让 tts_server(9882) 在下次 /tts 时读到新音色(切音色即刻生效)。
						try { writeVoiceManifest(newList); } catch (e) { ctx.logger?.warn?.(`dsh-client-ui-voice-input: manifest write ${e?.message ?? e}`); }
						jsonResponse(res, 200, { ok: true, id, name: entry.name, text });
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/voices/commit ${err?.message ?? err}`);
						jsonResponse(res, err?.code === "voices_full" ? 400 : 500, { ok: false, error: String(err?.message || err), code: err?.code });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/voices/commit");

			// 删除：移出 voices + 删 runtime/voices/<id> 目录。若删的是当前选中，回退到第一个/空。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/voices/delete",
				handler: async (req, res) => {
					try {
						const body = await parseJson(req);
						const id = String(body.id || "");
						if (!id) { jsonResponse(res, 400, { ok: false, error: "missing id" }); return; }
						const list = readVoiceList();
						const newList = list.filter((v) => v.id !== id);
						if (newList.length === list.length) { jsonResponse(res, 404, { ok: false, error: "音色不存在" }); return; }
						let newSel;
						const cur = (voiceSettings.ready && voiceSettings.svc) ? (voiceSettings.svc.get(voiceSettings.ns) || {}) : {};
						if (String(cur.selectedVoiceId || "") === id) {
							newSel = newList.length ? String(newList[0].id) : "";
						}
						await writeVoiceList(newList, newSel);
						// 【音色manifest】与删除同步：重写清单，tts_server 下次 /tts 即生效。
						try { writeVoiceManifest(newList); } catch (e) { ctx.logger?.warn?.(`dsh-client-ui-voice-input: manifest write ${e?.message ?? e}`); }
						try { fs.rmSync(path.join(VOICE_RUNTIME_ROOT, id), { recursive: true, force: true }); } catch { /* ignore */ }
						jsonResponse(res, 200, { ok: true });
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/voices/delete ${err?.message ?? err}`);
						jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/voices/delete");

			// 试听：按 ?id=.. 返回 seg.wav（/voice/voice_file?id=..）。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/voice_file",
				handler: async (req, res) => {
					try {
						const u = new URL(req.url ?? "/", "http://localhost");
						const id = String(u.searchParams.get("id") || "");
						const which = String(u.searchParams.get("f") || "seg");
						if (!id) { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end("missing id"); return; }
						const file = path.join(VOICE_RUNTIME_ROOT, id, which === "raw" ? "raw.wav" : "seg.wav");
						if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("not found"); return; }
						const buf = fs.readFileSync(file);
						res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(buf.length), "Cache-Control": "no-store" });
						res.end(buf);
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/voice_file ${err?.message ?? err}`);
						if (!res.headersSent) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end("error"); } else { res.end(); }
					}
				},
			}), "dsh-client-ui-voice-input: /voice/voice_file");

			// 【观测】前端"停朗读"入口上报:记录"谁停了朗读 + 当时状态",写到 runtime/last_stop.log,
			// 供排查"重开📞后上一段语音停/该停没停"这类运行时时序问题(不改任何行为,只记录)。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/log_reading_stop",
				handler: async (req, res) => {
					try {
						const body = await parseJson(req);
						const entry = {
							at: new Date().toISOString(),
							reason: String(body.reason || ""),
							callActive: body.callActive,
							callArmed: body.callArmed,
							callSpeaking: body.callSpeaking,
							queueLen: body.queueLen,
							stack: String(body.stack || "").slice(0, 800),
						};
						const logPath = path.join(VOICE_RUNTIME_ROOT, "last_stop.log");
						fs.mkdirSync(VOICE_RUNTIME_ROOT, { recursive: true });
						fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
						jsonResponse(res, 200, { ok: true });
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/log_reading_stop ${err?.message ?? err}`);
						jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/log_reading_stop");

			// 【音色预热】前端切换音色时调用 → 转发给 9882 /prewarm,把该音色参考特征提前提取缓存,
			// 这样用户真正开口说第一句话时音色已就绪,首句更快更稳(不再"换音色后首句慢几秒")。
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: "/voice/voices/prewarm",
				handler: async (req, res) => {
					try {
						const body = await parseJson(req);
						const id = String(body.id || "");
						if (!id) { jsonResponse(res, 400, { ok: false, error: "missing id" }); return; }
						const ac = new AbortController();
						const tm = setTimeout(() => ac.abort(), 60000);
						try {
							const r = await fetch("http://127.0.0.1:9882/prewarm", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ spk: id }),
								signal: ac.signal,
							});
							const j = await r.json().catch(() => ({}));
							jsonResponse(res, 200, { ok: !!j.ok, id, cached: !!j.cached, error: j.ok ? null : String(j.error || "") });
						} finally {
							clearTimeout(tm);
						}
					} catch (err) {
						ctx.logger?.warn?.(`dsh-client-ui-voice-input: /voice/voices/prewarm ${err?.message ?? err}`);
						jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
					}
				},
			}), "dsh-client-ui-voice-input: /voice/voices/prewarm");
		} else {
			console.warn("[dsh-client-ui-voice-input] webServer unavailable; device/model detection routes skipped");
		}
	} catch (error) {
		console.warn("[dsh-client-ui-voice-input] detection routes skipped (error):", error?.message);
	}
}
//#endregion
export { apply };
