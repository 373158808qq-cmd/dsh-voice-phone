window.__ModuleLoader__.load({
	id: "dsh-voice-phone-ui-input",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/speech.ts
		/**
		* Resolve the browser SpeechRecognition constructor (webkit-prefixed for
		* older Chrome/Edge), or undefined when the browser does not support it.
		* @returns the constructor, or undefined when unsupported.
		*/
		function resolveSpeechRecognition() {
			if (typeof window === "undefined") return void 0;
			const anyWindow = window;
			return anyWindow.SpeechRecognition ?? anyWindow.webkitSpeechRecognition;
		}
		/**
		* Create a browser recognition instance, or null when unsupported.
		* @returns a fresh recognition, or null when the browser lacks Web Speech.
		*/
		function createBrowserRecognition() {
			const ctor = resolveSpeechRecognition();
			return ctor === void 0 ? null : new ctor();
		}
		/**
		* Start a MediaRecorder recording session and return a promise that resolves
		* to the recorded audio bytes on stop (after the caller grants the mic).
		* Used to replace the unreliable browser online speech recognition with a
		* local whisper STT round-trip: record while held, stop on release, send the
		* audio to /voice/stt, and submit the returned text into the session.
		* @returns {controller} with {start, stop: () => Promise<{blob, audioBytes}>}.
		*/
		function createMediaRecorderController() {
			let recorder = null;
			let stream = null;
			let chunks = [];
			let resolveStop = null;
			let rejectStop = null;
			const finished = new Promise((res, rej) => {
				resolveStop = res;
				rejectStop = rej;
			});
			return {
				async start() {
					stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					chunks = [];
					recorder = new MediaRecorder(stream);
					recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
					recorder.onstop = () => {
						const type = recorder.mimeType || "audio/webm";
						const blob = new Blob(chunks, { type });
						resolveStop({ blob, mimeType: type });
					};
					recorder.onerror = (e) => rejectStop(e.error || new Error("MediaRecorder error"));
					recorder.start();
				},
				stop() {
					if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch {} }
					stream && stream.getTracks().forEach((t) => t.stop());
				},
				finished,
			};
		}
		/**
		* Accumulates recognition transcript into a final + interim model. Interim
		* segments replace each other (live feedback) while final segments commit;
		* the full transcript is what the mic appends to the draft.
		*/
		var TranscriptAccumulator = class {
			finalParts = [];
			interimText = "";
			/** Commit one final segment. */
			appendFinal(text) {
				this.finalParts.push(text);
				this.interimText = "";
			}
			/** Replace the current interim segment (live, non-committed). */
			setInterim(text) {
				this.interimText = text;
			}
			/** The full accumulated transcript (final segments + latest interim). */
			get transcript() {
				return [...this.finalParts, this.interimText].filter((part) => part.length > 0).join(" ");
			}
			/** Whether any final segment has committed. */
			get isFinal() {
				return this.finalParts.length > 0;
			}
			/** Start a fresh recognition session. */
			reset() {
				this.finalParts = [];
				this.interimText = "";
			}
		};
		/**
		* Fold one recognition result event into the accumulator.
		* @param acc - the accumulator to fold into.
		* @param event - the result event (results before `resultIndex` are unchanged).
		*/
		function applyResults(acc, event) {
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				if (result === void 0) continue;
				const text = result[0]?.transcript ?? "";
				if (result.isFinal) acc.appendFinal(text);
				else acc.setInterim(text);
			}
		}
		/** Pick a natural (preferred) voice: Microsoft neural / Edge voices, else any Chinese voice. */
		function pickPreferredVoice() {
			const voices = window.speechSynthesis?.getVoices?.() ?? [];
			if (voices.length === 0) return void 0;
			const natural = voices.find((v) => /natural/i.test(v.name) || v.name.includes("Online"));
			if (natural !== void 0) return natural;
			return voices.find((v) => /zh/i.test(v.lang)) ?? voices[0];
		}
		/**
		* A TTS speaker over `speechSynthesis`, preferring a natural (Edge/neural)
		* voice. NOTE: browser `speechSynthesis` is best-effort — Chrome silently
		* drops `speak()` calls after ~15s of speech inactivity, so we `resume()`
		* (and cancel) before every utterance as the known workaround. Quality and
		* reliability are browser-vendor dependent.
		*/
		function createBrowserSpeaker() {
			const synth = window.speechSynthesis;
			const voice = pickPreferredVoice();
			return {
				get speaking() {
					return synth.speaking;
				},
				onend: null,
				speak(text) {
					if (text.trim().length === 0) return;
					synth.cancel();
					synth.resume();
					const utterance = new SpeechSynthesisUtterance(text);
					if (voice !== void 0) utterance.voice = voice;
					utterance.rate = 1;
					utterance.pitch = 1;
					utterance.onend = () => this.onend?.();
					utterance.onerror = () => this.onend?.();
					synth.speak(utterance);
				},
				stop() {
					synth.cancel();
				}
			};
		}
		/**
		* Shared Web Audio context. Resumed inside the mic gesture so reply playback
		* through it is exempt from the browser autoplay policy (a plain
		* `HTMLMediaElement.play()` is blocked when it runs after the gesture window).
		*/
		let replyAudioCtx;
		/**
		* Unlock reply audio within a user gesture (the mic pointer-down): create and
		* resume the shared AudioContext so the reply is later playable. No-op when
		* Web Audio is unavailable — playback falls back to an `<audio>` element,
		* which is allowed once the user has interacted with the page.
		*/
		function unlockReplyAudio() {
			try {
				replyAudioCtx ??= new AudioContext();
				if (replyAudioCtx.state === "suspended") replyAudioCtx.resume();
			} catch {
				replyAudioCtx = void 0;
			}
		}
		/**
		* Parse a standard 44-byte PCM WAV header. Returns {channels, sampleRate, bits} or null.
		*/
		function parseWavPcmHeader(bytes) {
			if (!bytes || bytes.length < 44) return null;
			const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			if (dv.getUint32(0, true) !== 0x46464952) return null;      // "RIFF"
			if (dv.getUint32(8, true) !== 0x45564157) return null;      // "WAVE"
			if (dv.getUint16(20, true) !== 1) return null;             // 1 = PCM
			return {
				channels: dv.getUint16(22, true) || 1,
				sampleRate: dv.getUint32(24, true),
				bits: dv.getUint16(34, true) || 16,
			};
		}
		/** Convert interleaved int16 PCM bytes to a single-channel Float32Array in [-1,1]. */
		function pcm16ToFloat32(bytes) {
			const n = bytes.length >> 1;
			const out = new Float32Array(n);
			const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
			return out;
		}
		/** 线性插值重采样:把 fromRate 的样本重采样到 toRate(流式 TTS 是 32000,播放上下文可能是 44100/48000)。 */
		function resampleLinear(src, fromRate, toRate) {
			if (!src || src.length === 0 || fromRate === toRate) return src;
			const ratio = fromRate / toRate;
			const outLen = Math.max(1, Math.round(src.length / ratio));
			const out = new Float32Array(outLen);
			for (let i = 0; i < outLen; i++) {
				const pos = i * ratio;
				const i0 = Math.floor(pos);
				const i1 = Math.min(i0 + 1, src.length - 1);
				const frac = pos - i0;
				out[i] = src[i0] * (1 - frac) + src[i1] * frac;
			}
			return out;
		}
		/**
		* 【音色】读"当前选中音色 id"(设置页 voice-input 命名空间的 selectedVoiceId)。
		* 设置页/scope 不可用时返回空串 → /api/tts 不带 &spk= → 服务端用默认 zry 音色。
		*/
		function currentVoiceSpk() {
			try {
				if (voiceSettingsScope && typeof voiceSettingsScope.getSnapshot === "function") {
					const snap = voiceSettingsScope.getSnapshot();
					const v = snap && snap.value && typeof snap.value === "object" ? snap.value : {};
					if (typeof v.selectedVoiceId === "string") return v.selectedVoiceId;
				}
			} catch { /* ignore */ }
			return "";
		}
		/**
		* A TTS speaker preferring the host `/api/tts` route — Edge neural voices
		* synthesized server-side and served as MP3 — and falling back to the browser
		* `speechSynthesis` when the route is unreachable or fails. Playback runs
		* through the gesture-unlocked Web Audio context when available, else an
		* `<audio>` element, so it is not subject to the autoplay policy.
		*/
		function createReplySpeaker(fetchImpl = globalThis.fetch.bind(globalThis)) {
			const audio = new Audio();
			replyAudioEls.push(audio); // 注册 <audio> 兜底,供全局静音同步 audio.muted
			let browser;
			let speaking = false;
			let onEnd = null;
			let activeSource = null;
			let activeUrl = null;
			// 【全局静音=音量闸门】播放输出统一接全局 GainNode(见 ensureGlobalMuteGain/setGlobalMute):
			// 静音只把增益置 0,朗读照常推进;恢复即有声音。绝不打断,杜绝"取消后没声音/错位"。
			// 【代际守卫】每次 speak()/stop() 递增;在途 /api/tts fetch 返回后校验,过期则丢弃(否则打断后"停了又播"、且与下一段叠音)。
			let speakSeq = 0;
			// 【无缝流式 TTS】用 ScriptProcessor 持续渲染,从 pending 队列取样本 → 块与块真正无缝,
			// 不再用"一次性 AudioBufferSource 拼接"(那个会在块间产生爆音/噪音)。代号 gen 用于作废旧流。
			let streamReader = null;
			let streamGen = 0;
			let playBuf = new Float32Array(0); // 待播放样本队列(已重采样到 ctx 采样率)
			let playOffset = 0;                // playBuf 已消费位置
			let streamDone = false;            // 流是否已读完
			let outProc = null;                // 持续渲染的 ScriptProcessor
			// 作废并清理一切在途流式资源(读取器 + 播放队列 + 渲染器),并把代号 +1 使旧流失效。
			const clearStream = () => {
				streamGen += 1;
				if (streamReader !== null) {
					try { streamReader.cancel(); } catch {}
					streamReader = null;
				}
				playBuf = new Float32Array(0);
				playOffset = 0;
				streamDone = false;
				if (outProc !== null) {
					try { outProc.onaudioprocess = null; outProc.disconnect(); } catch {}
					outProc = null;
				}
			};
			const finish = () => {
				speaking = false;
				activeSource = null;
				activeUrl = null;
				onEnd?.();
			};
			/** Play a synthesized MP3/WAV, preferring Web Audio; an `<audio>` element is the fallback. */
			const playBuffer = async (buffer) => {
				const ctx = replyAudioCtx;
				if (ctx !== void 0) try {
					const decoded = await ctx.decodeAudioData(buffer.slice(0));
					const source = ctx.createBufferSource();
					source.buffer = decoded;
					// 经全局静音闸门输出(静音=增益0,不打断播放)。
					source.connect(ensureGlobalMuteGain() ?? ctx.destination);
					source.onended = () => {
						activeSource = null;
						finish();
					};
					activeSource = source;
					source.start();
					return;
				} catch (err) {
					console.warn("[dsh-voice] play: WebAudio failed, fallback to <audio>", err?.message);
				}
				const url = URL.createObjectURL(new Blob([buffer], { type: "audio/mpeg" }));
				activeUrl = url;
				audio.src = url;
				audio.muted = globalMuted; // <audio> 兜底路径同样走全局静音闸门(不打断播放)。
				audio.onended = () => {
					activeUrl = null;
					finish();
				};
				audio.onerror = () => {
					console.warn("[dsh-voice] play: <audio> ERROR");
					const u = activeUrl;
					activeUrl = null;
					if (u !== null) URL.revokeObjectURL(u);
					finish();
				};
				try {
					await audio.play();
				} catch (error) {
					console.warn("[dsh-voice] play: <audio> play() threw", error?.message);
					const u = activeUrl;
					activeUrl = null;
					if (u !== null) URL.revokeObjectURL(u);
					throw error;
				}
			};
			/**
			* 【无缝流式 TTS】读 /api/tts?streaming=1: 首块是 44 字节 WAV 头(取采样率),之后全是 raw int16 PCM。
			* 用 ScriptProcessor 持续渲染队列实现无缝播放(不产生块间爆音);读完流后由渲染器在播空时触发 finish()。
			*/
			const speakStreaming = async (text, gen) => {
				const spk = currentVoiceSpk();
				const resp = await fetchImpl(`/api/tts?streaming=1&text=${encodeURIComponent(text)}${spk ? "&spk=" + encodeURIComponent(spk) : ""}`);
				if (!resp.ok) throw new Error(`host TTS streaming responded ${resp.status}`);
				const ctx = replyAudioCtx;
				if (ctx === void 0) throw new Error("no reply audio context");
				// 建立"持续渲染"的 ScriptProcessor:每次回调从 playBuf 连续取样本填输出 → 无缝。
				if (outProc === null) {
					outProc = ctx.createScriptProcessor(2048, 1, 1);
					outProc.onaudioprocess = (e) => {
						const out = e.outputBuffer.getChannelData(0);
						const n = out.length;
						const avail = playBuf.length - playOffset;
						const copy = Math.max(0, Math.min(n, avail));
						if (copy > 0) {
							for (let i = 0; i < copy; i++) out[i] = playBuf[playOffset + i];
							playOffset += copy;
						}
						for (let i = copy; i < n; i++) out[i] = 0;
						if (playOffset >= playBuf.length) { playBuf = new Float32Array(0); playOffset = 0; }
						// 流已读完且队列播空 → 收尾(断开渲染器,触发 finish)。
						if (streamDone && playOffset === 0 && playBuf.length === 0) {
							if (outProc !== null) { try { outProc.onaudioprocess = null; outProc.disconnect(); } catch {} outProc = null; }
							if (gen === streamGen) finish();
						}
					};
					outProc.connect(ensureGlobalMuteGain() ?? ctx.destination);
				}
				const reader = resp.body.getReader();
				streamReader = reader;
				// 累积读取,直到凑齐 44 字节 WAV 头。
				let head = new Uint8Array(0);
				while (head.length < 44) {
					const { done, value } = await reader.read();
					if (done) break;
					const merged = new Uint8Array(head.length + value.length);
					merged.set(head, 0);
					merged.set(value, head.length);
					head = merged;
				}
				const hdr = parseWavPcmHeader(head);
				if (!hdr || !hdr.sampleRate) throw new Error("unexpected stream header");
				const srcRate = hdr.sampleRate;         // 流式音频采样率(32000)
				const outRate = ctx.sampleRate;          // 播放上下文采样率
				// 逐块:解 int16 → 重采样到上下文采样率 → 追加到播放队列(渲染器无缝取用)。
				const pushPcm = (bytes) => {
					if (!bytes || bytes.length < 2) return;
					const samples = pcm16ToFloat32(bytes);
					if (samples.length === 0) return;
					const rs = resampleLinear(samples, srcRate, outRate);
					const nb = new Float32Array(playBuf.length + rs.length);
					nb.set(playBuf, 0);
					nb.set(rs, playBuf.length);
					playBuf = nb;
				};
				// 头部可能带着首块数据(超过 44 字节的部分),先入队。
				if (head.length > 44) pushPcm(head.subarray(44));
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (gen !== streamGen) throw new Error("stream superseded");
					pushPcm(value);
				}
				streamReader = null;
				streamDone = true; // 标记流读完;渲染器会在播空时触发 finish()。
			};
			/**
			* Stop every playback path without firing the end callback (a manual stop
			* must not look like a natural end to the caller's queue logic).
			*/
			const stopAll = () => {
				speakSeq += 1; // 作废一切在途 /api/tts fetch(中断后不再播放)
				clearStream();
				if (activeSource !== null) {
					activeSource.onended = null;
					try {
						activeSource.stop();
					} catch {}
					activeSource = null;
				}
				audio.onended = null;
				audio.pause();
				const url = activeUrl;
				activeUrl = null;
				if (url !== null) URL.revokeObjectURL(url);
				browser?.stop();
				browser = void 0;
				speaking = false;
			};
			return {
				get speaking() {
					return speaking;
				},
				get onend() {
					return onEnd;
				},
				set onend(callback) {
					onEnd = callback;
				},
				speak(text) {
					if (text.trim().length === 0) return;
					stopAll();
					speaking = true;
					const gen = speakSeq; // 本段代号:若后续被 stop()/新 speak() 覆盖,则丢弃在途音频
					// —— 话筒/文字/📞 通用路径:原"整段缓冲"逻辑(已验证可用,干净无噪) ——
					const spk = currentVoiceSpk();
					fetchImpl(`/api/tts?text=${encodeURIComponent(text)}${spk ? "&spk=" + encodeURIComponent(spk) : ""}`).then((response) => {
						if (!response.ok) throw new Error(`host TTS responded ${response.status}`);
						return response.arrayBuffer();
					}).then((buffer) => {
						if (gen !== speakSeq) return; // 已被打断/切轮:丢弃,不播
						return playBuffer(buffer);
					}).catch(() => {
						if (gen !== speakSeq) return;
						console.warn("[dsh-voice] host /api/tts failed; falling back to browser speechSynthesis");
						const fallback = createBrowserSpeaker();
						fallback.onend = finish;
						browser = fallback;
						fallback.speak(text);
					});
				},
				stop() {
					stopAll();
				}
			};
		}
		//#endregion
		//#region src/client/MicButton.tsx
		/**
		* The single composer voice control:
		* - tap → toggle continuous monitoring: speech streams into the draft live
		*   (逐字输入). Monitoring keeps listening across silences by auto-restarting
		*   the recognizer on each segment end (Chrome's `continuous: true` fails to
		*   deliver results, so each segment runs `continuous: false` and restarts).
		* - press-and-hold → voice chat (record while held, release to send; the reply
		*   is read aloud).
		* Recognition starts on pointer-down (a user gesture, required by the Web
		* Speech API); tap vs hold is decided on release.
		* @module @deepseek-ai/dsh-client-ui-voice-input/src/client/MicButton
		*/
		/** How long a press must be held before release counts as "hold to chat". */
		const HOLD_THRESHOLD = 250;
		/** DeepSeek brand blue, used while the mic is listening. */
		const DEEPSEEK_BLUE = "#4d6bfe";
		/** Extract the assistant's visible text blocks from the streaming partial reply. */
		function extractPartialText(partial) {
			if (partial === null || partial === void 0) return "";
			const blocks = Array.isArray(partial.blocks) ? partial.blocks : [];
			return blocks.filter((block) => block.kind === "text").map((block) => block.text ?? "").join("");
		}
		/** 从聊天节点(user/assistant)提取可见文字;兼容多种节点形态,缺字段绝不抛错(空则返回"")。 */
		function nodeText(node) {
			if (!node || node === void 0) return "";
			if (Array.isArray(node.blocks)) {
				return node.blocks.filter((b) => b && (b.kind === "text" || b.type === "text")).map((b) => b.text || "").join("");
			}
			const content = (node.message && node.message.content) || node.content;
			if (Array.isArray(content)) {
				return content.filter((b) => b && (b.type === "text" || b.kind === "text")).map((b) => b.text || "").join("");
			}
			if (typeof node.text === "string") return node.text;
			if (node.message && typeof node.message.text === "string") return node.message.text;
			return "";
		}
		/**
		* 【📞边聊边总结】判断一段语音识别结果是否是"总结一下/总结"请求(保守匹配,防误触发)。
		* 只在"简短、以总结为核心动词"的命令形态上返回 true:
		*   - 允许常见前缀(帮我/给我/请/麻烦/来/那/嗯/你/我们 等语气词/称呼)与少量句尾辅助词(一下/下/刚才/刚刚/前面/目前/这段/刚才说的/刚才聊的 等);
		*   - 去掉这些辅助词后主干必须落在"总结"上;
		*   - 太长的句子(更像在讨论某主题,如"总结报告怎么写")或含更多实词的一律返回 false,绝不把普通含"总结"二字的对话当总结请求。
		*/
		function isSummaryRequest(text) {
			if (!text) return false;
			const t = String(text).trim();
			if (!t) return false;
			// 去掉断句/标点/空白,连成连续主干,便于匹配命令形态。
			const core = t.replace(/[，。！？、,.!?…~：:；;]/g, "").replace(/\s+/g, "");
			// 去掉开头语气词/称呼/前缀(那/嗯/请/帮我/给我们/你 等)，【循环去掉多个】，因为口语常是"那我们/你说的那个总结"这种叠前缀。
			let cmd = core;
			let prev0;
			do {
				prev0 = cmd;
				cmd = cmd.replace(/^(那|那个|嗯|呃|额|啊|这个|你|咱们|我们|请|帮我|给我|麻烦|麻烦你|帮我一下|来|给|然后|就是说|让我|由我|要|想|需要|能不能|可以)/, "");
			} while (cmd !== prev0);
			// 必须"以总结开头";长句更像在讨论某主题,不当作总结请求(防误触发)。
			if (!/^总结/.test(cmd)) return false;
			if (cmd.length > 14) return false;
			// 反复去掉句尾辅助词,剩余主干应恰好是"总结"。
			let c = cmd;
			let prev;
			do {
				prev = c;
				c = c.replace(/(一下|下|刚|刚才|刚刚|前面|目前|当前|这段|这一段|一段|刚才说的|刚才聊的|刚才那些|我们刚才聊的|我们刚聊的|我们说的|我说的|我们聊的|聊的)$/, "");
			} while (c !== prev);
			return c === "总结";
		}
		/**
		* 【📞边聊边总结】取"通话归属会话"sessionId 的 snapshot 中最近 maxNodes 条 user/assistant 节点文本,
		* 按"用户：…/助手：…"拼接成一段,作为 /voice/summarize 的输入(取不到则返回空串)。
		* 只读 snapshot,不改任何状态。
		*/
		function getRecentConversationText(sessionId, maxNodes) {
			try {
				const snap = sessionsRef?.binding(sessionId)?.session?.getSnapshot();
				// 【DSH 0.1.2 兼容】优先 useChat 缓存,回退旧快照。
				const nodes = (callChatNodesCache && callChatNodesCache.length > 0) ? callChatNodesCache : (snap?.nodes || []);
				const roles = [];
				const limit = maxNodes || 8;
				for (let i = nodes.length - 1; i >= 0 && roles.length < limit; i--) {
					const n = nodes[i];
					if (n && (n.kind === "user" || n.kind === "assistant")) {
						const txt = nodeText(n).trim();
						if (txt) roles.push({ role: n.kind, text: txt });
					}
				}
				roles.reverse();
				return roles.map((r) => (r.role === "user" ? "用户：" : "助手：") + r.text).join("\n");
			} catch { return ""; }
		}
		/**
		* 【总结·只取当前这轮】取"最近一条 user 提问"之后的 user/assistant 内容(不把上面的历史本轮卷进来)。
		* 用于"总结一下":总结范围 = 你这次提问 → agent 回复这段,而不是更早的历史。只读 snapshot,不改状态。
		*/
		function getCurrentTurnConversation(sessionId) {
			try {
				const snap = sessionsRef?.binding(sessionId)?.session?.getSnapshot();
				// 【DSH 0.1.2 兼容】优先用 useChat 缓存(带 kind/seq),回退旧快照。
				const nodes = (callChatNodesCache && callChatNodesCache.length > 0) ? callChatNodesCache : (snap?.nodes || []);
				let lastUserIdx = -1;
				for (let i = nodes.length - 1; i >= 0; i--) {
					const n = nodes[i];
					if (n && n.kind === "user") { lastUserIdx = i; break; }
				}
				if (lastUserIdx < 0) return "";
				const roles = [];
				for (let i = lastUserIdx; i < nodes.length; i++) {
					const n = nodes[i];
					if (n && (n.kind === "user" || n.kind === "assistant")) {
						const txt = nodeText(n).trim();
						if (txt) roles.push({ role: n.kind, text: txt });
					}
				}
				return roles.map((r) => (r.role === "user" ? "用户：" : "助手：") + r.text).join("\n");
			} catch { return ""; }
		}
		/** Sentence-end delimiters used to cut streamed text into speakable segments. */
		const SENTENCE_END = /[。！？!?…\n]$/;
		/** Flush a buffered (delimiter-less) sentence once it gets this long, so long sentences still stream. */
		const STREAM_FLUSH_CHARS = 30;
		/** 分段总结的时间边界:每隔这么多毫秒,把新累积的文字总结成一段口语总结并朗读。 */
		const SEGMENT_SUMMARY_MS = 10000;
		/** 收尾稳定期:判定回复看似完成后,再等这么久确认不再变化,才说完整收尾总结/引导语。 */
		const SETTLE_MS = 600;
		/** 分段总结的最小新文字量:新文字达到这么多字才单独总结(避免把流式输出碎片化)。 */
		const SEGMENT_SUMMARY_MIN_CHARS = 40;
		/** 结尾引导句:只在"最终收尾总结"里出现,中间分段总结不带这句。 */
		const GUIDING_SENTENCE = "以上这些差不多，如果有问题随时问我。";
		/** 【B】拼到📞提交前的"总结指南":让 agent 在回复末尾用 <speak>...</speak> 给一段口语总结,语音直接读它(省二次总结)。 */
		const SPEAK_GUIDE = "（语音对讲）请用中文回答。先给用户看的完整内容（可含代码/列表，正常显示）；在最末尾用一行 <speak>...</speak> 给一段≤150字的『对话式口语总结』——像跟人聊天一样，无代码、无列表、无markdown、短句，把这段内容的要点说清楚。语音只朗读 <speak> 这段总结。";
		/** 【B1】📞通话"边生成边逐句念"的轻量提示:尽量短、不支配信息,避免 agent 复述这段提示导致重复/上下文串入回答。 */
		const B1_GUIDE = ("（语音通话）请用中文、简洁、口语回答，先说结论。"
			+ "遇到代码、技术结构、API、数字、英文术语、符号时：**一定要用大白话把它『翻译/解释』清楚，不要跳过、不要照念原始代码或符号**，"
			+ "要念准发音（如把英文单词读成中文音译或说清意思）。"
			+ "整体像跟人面对面聊天一样自然、有节奏，别念成机器人。");
		/** 收尾句:作为独立的结尾(带引导语)播报,不塞进某段总结。 */
		const CLOSING_TEXT = "以上这些差不多，如果有问题随时问我。";
		/** 总结拆分:每段源文本最大长度(超出就另起一次 GPT 总结),保证每段总结不超长、音频不超时。 */
		const SUMMARIZE_CHUNK_MAX = 500;
		/** 【B1】自然韵律:攒够这么多字才作为一整块送 TTS。用户反馈 70 字太碎(一句句念、停顿生硬)，
		* 调到 140 字(约长段落)让语音更大段、更连贯(跨句自然停顿时长/抑扬,不像机器人)。 */
		const B1_CHUNK_MIN = 140;
		/** 【📞全局单点】📞 通话归属的会话 id(null=当前没有通话)。通话说到底属于发起它的那个会话(A):
		* 不管当前在查看哪个会话,通话都跟在 A 后面;其它会话的 📞 按钮被这个全局通话占用/禁用。 */
		let globalCallSessionId = null;
		/** 【📞全局单点】是否有全局通话开着(与 globalCallSessionId 配套)。只由"发起通话的会话"开/关;
		* 切会话【不改变它】—— 所以 A 的通话不会因切走被掐断,只有真正"挂断"才清零。 */
		let voiceCallActive = false;
		/** 【📞全局兜底资源】当前通话占用的麦克风/WS/AudioContext 物理资源(模块级,不随组件重建丢失)。
		* 用于"挂断必释放麦克风":A↔B 切来切去会重建按钮组件,组件级 stopRef 可能丢,但模块级这里始终在,
		* 任何实例的挂断/断流都能从这里把麦克风轨停干净,杜绝"挂了电话麦克风还在录"。 */
		let callAudioRef = null;
		/** 【📞全局单点】最近一次"语音类输入(话筒/📞)"发生在哪个会话。用来把朗读归属到正确会话:
		* A 的通话朗读只认 A;切到 B 时不会把 B 的回复当成"语音输入"去读(防切会话串读)。 */
		let voiceInputSessionId = null;
		/** 【📞重开保护期】重开📞(麦克风刚建立)的"忽略 speech_start 直到"时间戳(毫秒)。
		*  重开瞬间 VAD 常把环境/过渡声误判成"你开口"→ 停掉正在念的上一段(用户实测的bug)。
		*  在保护期内忽略 speech_start,防误停;保护期过后(你真正说话)才生效。 */
		let callSpeechIgnoreUntil = 0;
		/** 【📞防误重武装·持久基线】按会话记录"已处理的 user 节点最大 seq"。
		*  必须放【模块级】(而非组件 useRef):组件随会话切换重挂会把它清空,导致切回会话时把
		*  全部历史 user 节点误判为"新语音输入" → 触发重武装 → 正在朗读的被打断(切回停声的根因)。
		*  持久化后切走/切回不丢,历史消息不再被当新输入,朗读不被误打断。 */
		const lastUserSeqBySession = {};
		/** 【📞B1】最近一次"语音类输入"是否是📞(true=通话;false=话筒按住说)。用来给回复朗读选模式:
		* 通话→B1"边生成边逐句念";话筒→旧"每10秒总结"。按"最近一次输入"记,配合按会话归属,话筒始终走旧路径。 */
		let voiceInputIsCall = false;
		/** 【📞自动接话】"最近一次语音类输入(话筒/通话)"的时间戳,供回复朗读协调(任一来源都触发读回复)。 */
		let sharedVoiceAt = 0;
		/** 【📞防重复】"上次已提交的 turn"时间与文本:用于忽略 VAD 重复发/自家语音回环造成的同句二次提交。 */
		let lastTurnAt = 0;
		let lastTurnText = "";
		/** 【📞防重复·归一化】去掉标点/空白只留核心字,用于判"两句是否同一句"(避免"你好"与"你好。""你好 "被当不同句)。
		*  返回小写字母+数字+汉字的紧凑串。 */
		function normTurnText(t) {
			return String(t || "").toLowerCase().replace(/[\s，。！？!?、,..:：；;()（）"'“”‘’\-_~·]+/g, "").trim();
		}
		/** 【barge-in】话筒注册的"打断"处理器;📞 按钮检测到用户开口时调用,立即停朗读+取消生成。 */
		let voiceInterruptHandler = null;
		/** 【📞挂断】只"停朗读"(不取消 agent 生成,让回复文字留在会话里);由把📞挂断时调用 —— 真正挂断才停,切会话不停。 */
		let voiceStopReadingHandler = null;
		/** 【跨会话通话状态机·voiceBusy】最近"语音来源会话"的语音是否还在播/还有没播完的内容(供别的会话决策)。
		* 语义 = speaker 正在播 || ttsQueue 还有未播内容 || 正在朗读。由 MicButton 在读/停/播关键点同步(syncVoiceBusy)。
		* 它不区分路径(📞/话筒)也不绑定具体会话;但"朗读"只可能发生在"武装归属"的那一个会话(syncVoiceBusy 同时记录 voiceBusySessionId),
		* 所以 voiceBusy=true 实际上就是"那个归属会话的语音还在播"。无通话时用它决定情况③。 */
		let voiceBusy = false;
		/** 【跨会话通话状态机】voiceBusy 对应的"正在播报的那个会话 id"(为 null 表示没在播)。
		* 用于区分:若是【当前会话自己的】语音在播 → 属于情况②"自己打断自己"(可直接用);
		* 若是【别的会话】的语音在播 → 属于情况③(需先确认是否立即结束)。 */
		let voiceBusySessionId = null;
		/** 【跨会话打断·活跃朗读登记】当前"正在朗读"的那一个会话及其朗读资源闭包(全局单点,同一时刻只有一份)。
		* 由武装朗读的那个会话(armReplyReading)写入 {sessionId, stop, cancel};朗读真正结束(finishReading)时清空。
		* 它解决"跨会话打断作用错对象"的根因:voiceInterruptHandler/voiceStopReadingHandler 是模块级变量,
		* 会被"当前查看会话"的渲染反复覆盖,导致打断时误停【当前会话 B】的朗读(而非【通话归属会话 A】的)。
		* 有了 activeReader,无论当前在看哪个会话,打断都先取 activeReader(即归属会话 A 的朗读资源)去停,
		* 从而"停 A 的 speaker + 清 A 的朗读队列 + 作废 A 的在途 TTS/总结",且 cancel 也落到 A。 */
		let activeReader = null;
		/** 【📞防无按钮自动采集】"当前正在查看的会话 id"(由 MicButton 按 sessionId 更新)。
		* 用于给 /voice/stream 的 turn 自动提交加一道门:只有当用户【正在看📞通话归属的会话】时才自动接话;
		* 若通话还开着、用户却切到别的会话(没在看归属会话),则丢弃 turn —— 否则通话的麦克风会把
		* 环境音/回声/旁边的视频音识别后自动提交,造成"没按按钮却自动采集+提交"。 */
		let currentViewSessionId = null;
		/** 【📞档位恢复·修复3】"进入通话前保存的原模型档位"(reasoningEffort/提供方/模型),退出时恢复。
		* 模块级单点,生命周期与 globalCallSessionId 一致:start() 写、restoreModel() 读、stop()/onclose 清。
		* 放在模块级而非 TelButton 组件 useRef —— 否则 A↔B 来回切会重挂组件、savedModelRef 被重置为 null,
		* 回 A 挂断时 restoreModel 读到 null 什么都不做,模型停在 applyEffort 最后设的 off(问题③)。 */
		let callSavedModelRef = null;
		/** 【📞并发守卫】start() 正在执行(含在途 getUserMedia)时为 true,挡掉"连点/双击"导致的二次 start。
		* 若无此守卫:getUserMedia 挂起期间第二次 start 会再开一条 getUserMedia 流并覆盖 callAudioRef/stopRef.current,
		* 第一条流被架空成孤儿(不在任何释放路径),其 ws 的 onclose 又被身份守卫吞掉 → 幽灵麦克风永久采集(根治点之一)。 */
		let callStarting = false;
		/** 【全局静音】=音量闸门:只把输出增益置 0,朗读照常推进(该读还读,只是听不见);
		*  恢复=切回有声。作用于【所有朗读路径】(📞通话/🎤话筒/文字读),不打断、不丢内容。
		*  与"麦克风采集/识别/提交"无关——纯输出层,绝不碰已验证的录音/打断/状态机。 */
		let globalMuted = false;
		let globalMuteGain = null;
		/** 所有 speakser 的 <audio> 兜底元素(全局静音时同步 audio.muted)。 */
		const replyAudioEls = [];
		function ensureGlobalMuteGain() {
			if (globalMuteGain === null && replyAudioCtx !== void 0) {
				try {
					globalMuteGain = replyAudioCtx.createGain();
					globalMuteGain.gain.value = globalMuted ? 0 : 1;
					globalMuteGain.connect(replyAudioCtx.destination);
				} catch { globalMuteGain = null; }
			}
			return globalMuteGain;
		}
		function setGlobalMute(v) {
			globalMuted = !!v;
			try { if (globalMuteGain !== null) globalMuteGain.gain.value = globalMuted ? 0 : 1; } catch {}
			for (const el of replyAudioEls) { try { el.muted = globalMuted; } catch {} }
			// 广播给所有会话的静音按钮(跨会话同步 🔊/🔇 图标)。
			try { window.dispatchEvent(new CustomEvent("voice-global-mute", { detail: globalMuted })); } catch {}
		}
		/** 【📞图标随状态刷新】在任何"改 voiceCallActive/globalCallSessionId"的地方调用,广播一个事件,
		*  让所有 TelButton 图标重渲染(否则某条路径改了状态却没触发渲染 → 图标卡在旧颜色,如"通话中变绿")。 */
		function notifyCallStateChange() {
			try { window.dispatchEvent(new CustomEvent("voice-call-state")); } catch {}
		}
		/** 【观测·停朗读上报】前端在"停朗读/重新武装/重开"等关键入口调用,把"谁停了+状态"发到后端日志,
		*  供我(无浏览器控制台)读取定位运行时时序问题(如"重开📞后上一段语音停")。只记录,不改行为。 */
		function logReadingStop(reason) {
			try {
				let stack = "";
				try { stack = new Error().stack || ""; } catch {}
				const body = JSON.stringify({
					reason,
					callActive,
					callArmed,
					callSpeaking,
					queueLen: callQueue.length,
					stack,
				});
				fetch("/voice/log_reading_stop", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
			} catch { /* 观测失败不影响功能 */ }
		}
		// 【📞图标·用 useSyncExternalStore 可靠订阅】把"当前通话状态"做成一个外部源,供 TelButton 用
		// useSyncExternalStore 订阅:状态一变必定重新渲染,绝不丢帧。这是 React 标准机制,比手动 forceRender 可靠。
		function subscribeCallState(cb) {
			try { window.addEventListener("voice-call-state", cb); } catch {}
			return () => { try { window.removeEventListener("voice-call-state", cb); } catch {} };
		}
		function getCallStateSnapshot() {
			// 返回一个可比较的对象:包含通话状态与归属。useSyncExternalStore 用引用比较判断"是否变了"。
			return voiceCallActive + "|" + globalCallSessionId;
		}
		//#region 【📞跨会话常驻朗读引擎】A 的📞朗读由常驻引擎驱动，不随 MicButton 卸载丢失
		/** 会话域引用：在 apply(ctx) 里捕获 ctx.sessions，供引擎跨会话订阅用(只读引用)。 */
		let sessionsRef = null;
		/** 【音色】设置命名空间 scope(apply 里捕获)。TTS 请求用它实时读"当前选中音色 id"，
		* 让 /api/tts 带上 &spk= 走 tts_server(9882) 多音色(切音色即刻生效；未选则不带，服务端用默认)。 */
		let voiceSettingsScope = null;
		/** 【📞常驻引擎】通话归属会话(A) snapshot 订阅的 unsubscribe 句柄。 */
		let callUnsub = null;
		/** 【📞常驻引擎】通话是否在持续(随 开/挂 切换)。 */
		let callActive = false;
		/** 【📞常驻引擎】引擎专用 speaker(与会话组件 speaker 隔离，不互相干扰)。 */
		let callSpeaker = null;
		/** 【📞常驻引擎】待念段队列。 */
		let callQueue = [];
		/** 【DSH 0.1.2 兼容·引擎数据源缓存】新版 session.getSnapshot() 不再返回 nodes(旧版有,新版断),
		*  而聊天节点列表(带 kind/seq)在新版只能经 React 的 useChat(s.legacy.nodes) 拿到。
		*  引擎是非 React 常驻模块,拿不到 useChat —— 故用这个模块级缓存: 组件(MicButton/TelButton)的
		*  useChat 拿到 legacy.nodes 时同步写入,引擎(callOnSnapshot/callArm/callDrive 等)从这里读。 */
		let callChatNodesCache = [];
		/** 【DSH 0.1.2 兼容】引擎读"流式输出文字"的缓存(新版 session.getSnapshot() 无 partial,数据在 useChat 的 legacy.partial)。
		*  组件 useChat 拿到时同步写,引擎从这里读;回退旧 snapshot.partial。 */
		let callPartialCache = null;
		/** 【DSH 0.1.2 兼容】引擎读"运行中工具调用"的缓存(新版 session.getSnapshot() 无 runningCalls,数据在 useChat 的 legacy.runningCalls)。 */
		let callRunningCallsCache = [];
		/** 【📞常驻引擎】是否正在念一段。 */
		let callSpeaking = false;
		/** 【📞常驻引擎】本条回复是否已收尾(队列播空即结束)。 */
		let callFinalized = false;
		/** 【📞B1】已念到的文字偏移。 */
		let callB1Spoken = 0;
		/** 【📞B1】已念过的句子集合(内容去重)。 */
		let callB1Seen = new Set();
		/** 【📞B1】已处理 partial 前缀(前缀去重)。 */
		let callB1Processed = "";
		/** 【📞B1】攒句(自然韵律，达到 B1_CHUNK_MIN 才整块送 TTS)。 */
		let callB1Chunk = "";
		/** 【📞常驻引擎】当前武装"读的这条回复"所属会话(=通话归属会话 A)。 */
		let callOwnerId = null;
		/** 【📞常驻引擎】武装对应的 user node seq(幂等/防重复武装)。 */
		let callArmedForSeq = -1;
		/** 【📞常驻引擎】是否已武装(正在读"某一条回复")。 */
		let callArmed = false;
		/** 【📞常驻引擎】已读到的最大 assistant seq 基线(seq<=baseline 的历史回复不算待读)。 */
		let callReplySeq = -1;
		/** 【📞常驻引擎】A 里已处理的最新 user seq(基线：已有历史不当作"新语音输入")。 */
		let callLastUserSeq = -1;
		/** 【📞B1】"等一下"提示是否已说(只一次)。 */
		let callThinkingNotified = false;
		/** 【📞常驻引擎】最近一次出现正文的时间戳(长任务判定)。 */
		let callLastContentAt = 0;
		/** 【📞常驻引擎】代号：每次新回复/打断 +1，作废在途。 */
		let callGen = 0;
		/** 【📞常驻引擎】收尾稳定期定时器 + 代号。 */
		let callSettleTimer = null;
		let callSettleGen = 0;
		/** 【📞常驻引擎】当前注册给 activeReader 的朗读资源闭包(打断落位到引擎)。 */
		let callReader = null;
		/** 解析某会话的 cancel(打断时用于取消该会话 agent 的生成)。 */
		function resolveSessionCancel(sid) {
			try {
				const actx = sessionsRef?.scope(sid);
				const conv = actx?.get("conversation");
				if (conv) return () => { try { conv.cancel(); } catch {} };
			} catch {}
			return () => {};
		}
		/** 引擎专属 speaker(懒创建)。 */
		function callGetSpeaker() {
			if (callSpeaker === null) callSpeaker = createReplySpeaker();
			return callSpeaker;
		}
		/** 同步模块级 voiceBusy：引擎是否还在播(供"别的会话"情况③判定)。 */
		function callSyncVoiceBusy() {
			const busy = callSpeaking || callQueue.length > 0 || !!(callSpeaker && callSpeaker.speaking);
			voiceBusy = busy;
			voiceBusySessionId = busy ? callOwnerId : null;
		}
		/** 逐段念；队列播空且已收尾则结束。 */
		function callPump() {
			const sp = callGetSpeaker();
			if (!sp || callSpeaking) return;
			const segment = callQueue.shift();
			if (segment === void 0) {
				if (callFinalized) callFinish();
				return;
			}
			callSpeaking = true;
			sp.onend = () => { callSpeaking = false; callSyncVoiceBusy(); callPump(); };
			sp.speak(segment);
			callSyncVoiceBusy();
		}
		/** 入队念(逐段转"人话版"文本)。 */
		function callEnqueue(segments) {
			for (const segment of segments) {
				const s = toSpeechText(segment);
				if (s.length > 0) callQueue.push(s);
			}
			if (callQueue.length === 0) return;
			callSyncVoiceBusy();
			callPump();
		}
		/** 引擎朗读自然结束：复位武装 + 注销 activeReader(单点门控由 voiceInputIsCall 决定,不在此清)。 */
		function callFinish() {
			callArmed = false;
			callSpeaking = false;
			if (activeReader === callReader) activeReader = null;
			callSyncVoiceBusy();
		}
		/** 【静音】=全局音量闸门:作用于📞通话/🎤话筒/文字朗读全部输出路径,朗读照常推进;
		*  与麦克风采集/识别/提交无关(纯输出层)。 */
		function callSetMuted(v) {
			if (globalMuted === v) return;
			setGlobalMute(v);
		}
		/** 打断/barge-in：停朗读、清队列、作废在途、重置 B1 进度，但【保持武装】——
		*  打断后 agent 重新生成(或新输入产生新内容)，引擎继续从 A 的 snapshot 读新内容并念(打断后能继续)。 */
		function callStopReading() {
			logReadingStop("callStopReading");
			callQueue = [];
			callSpeaking = false;
			callSpeaker && callSpeaker.stop();
			callGen += 1;
			callB1Chunk = "";
			callB1Spoken = 0;
			callB1Seen = new Set();
			callB1Processed = "";
			callFinalized = false;
			callThinkingNotified = false;
			callSettleGen += 1;
			if (callSettleTimer !== null) { clearTimeout(callSettleTimer); callSettleTimer = null; }
			callSyncVoiceBusy();
		}
		/** 【只停朗读声·不作废生成】引擎专用:开口时【只停当前朗读声音】,【不取消 agent 生成】、不作废在途文字。
		*  用途:你开口先让声音立刻停,但留出约1秒判断你是"总结一下"还是"其它话";
		*  若后续识别出"总结"→文字继续;若"其它话"→才由提交(steer)真正打断。 */
		function callStopReadingSoundOnly() {
			logReadingStop("callStopReadingSoundOnly");
			callQueue = [];
			callSpeaking = false;
			if (callSpeaker) { try { callSpeaker.stop(); } catch {} }
			callSyncVoiceBusy();
		}
		/** 释放常驻引擎(完全停，用于"话筒 turn 切换"：让 MicButton 读话筒，避免与引擎双读)。 */
		function callEngineRelease() {
			callQueue = [];
			callSpeaking = false;
			callSpeaker && callSpeaker.stop();
			callGen += 1;
			callB1Chunk = "";
			callArmed = false;
			callSettleGen += 1;
			if (callSettleTimer !== null) { clearTimeout(callSettleTimer); callSettleTimer = null; }
			if (activeReader === callReader) activeReader = null;
			callSyncVoiceBusy();
		}
		/** 收尾：整条回复已完成，补齐"余句 + 收尾语"。 */
		function callFinalizeReading(snap) {
			// 尽量用"settle 时刻之后的最新 snapshot"(避免 settle 定时器内的 snap 稍旧；取不到则回退传入的 snap)。
			let latest = snap;
			try {
				const s = sessionsRef?.binding(callOwnerId)?.session;
				if (s) latest = s.getSnapshot();
			} catch {}
			// 【DSH 0.1.2 兼容】优先 useChat 缓存,回退旧快照。
			const nodes = (callChatNodesCache && callChatNodesCache.length > 0) ? callChatNodesCache : (latest.nodes || []);
			let node = null;
			for (let i = nodes.length - 1; i >= 0; i--) {
				const n = nodes[i];
				if (n.kind === "assistant" && n.seq > callReplySeq) { node = n; break; }
			}
			if (!node) { callFinish(); return; }
			callReplySeq = node.seq;
			callArmed = false;
			const fullText = extractPartialText(node);
			const tail = fullText.length > callB1Spoken ? fullText.slice(callB1Spoken).trim() : "";
			if (callB1Chunk.trim()) { const s = toSpeechText(callB1Chunk); if (s) callEnqueue([s]); }
			callB1Chunk = "";
			if (tail) { const s = toSpeechText(tail); if (s) callEnqueue([s]); }
			// 【📞删结尾引导语】电话里不读"以上这些差不多..."这句结尾语(用户要求:电话删、话筒保留)。
			// 话筒走下方 GUIDING_SENTENCE 保留,不受影响。
			callFinalized = true;
			callSettleGen += 1;
			if (callSettleTimer !== null) { clearTimeout(callSettleTimer); callSettleTimer = null; }
		}
		/** 武装"读 A 的某条回复"：重置进度 + 登记 activeReader(打断落位到引擎)。 */
		function callArm(ownerId, afterSeq) {
			logReadingStop("callArm:" + afterSeq + " armedSeq=" + callArmedForSeq);
			// 【防重·根治"跳读/反复武装"】只看"要武装的这条 (afterSeq) 是否等于引擎已在读的那条 (callArmedForSeq)"。
			// 不能依赖 callArmed 标志:打断会把它置 false,但 callArmedForSeq 仍是旧值 → 同一条消息会被当成新输入,
			// callStopReading() 每次把正在读的停一刀又重开 → 同一句被跳读两三次(日志实锤)。
			// 只要 seq 相同(引擎持有着这条),就绝不打断,让引擎继续念。
			if (callOwnerId === ownerId && callArmedForSeq === afterSeq) return;
			callStopReading();
			callOwnerId = ownerId;
			callArmedForSeq = afterSeq;
			const snap = sessionsRef?.binding(ownerId)?.session?.getSnapshot();
			// 【DSH 0.1.2 兼容】优先 useChat 缓存,回退旧快照。
			const nodes = (callChatNodesCache && callChatNodesCache.length > 0) ? callChatNodesCache : (snap?.nodes || []);
			let maxAsst = -1;
			for (const n of nodes) if (n.kind === "assistant" && typeof n.seq === "number" && n.seq < afterSeq && n.seq > maxAsst) maxAsst = n.seq;
			callReplySeq = maxAsst;
			callB1Spoken = 0;
			callB1Seen = new Set();
			callB1Processed = "";
			callB1Chunk = "";
			callThinkingNotified = false;
			callLastContentAt = Date.now();
			callFinalized = false;
			callArmed = true;
			callGen += 1;
			callSettleGen += 1;
			if (callSettleTimer !== null) { clearTimeout(callSettleTimer); callSettleTimer = null; }
			callReader = {
				sessionId: ownerId,
				stop: callStopReading,
				cancel: resolveSessionCancel(ownerId),
			};
			activeReader = callReader;
		}
		/** 驱动：B1 边生成边逐句念 + 收尾判定(从 A 的 snapshot 读)。 */
		function callDriveOnSnapshot(snap) {
			if (!callArmed) return;
			// 【DSH 0.1.2 兼容】partial/runningCalls 新版 session.getSnapshot() 已无(在 useChat legacy),优先用缓存,回退快照。
			const partial = (callPartialCache !== null && callPartialCache !== void 0) ? callPartialCache : snap.partial;
			const running = snap.running;
			const runningCalls = (callRunningCallsCache && callRunningCallsCache.length > 0) ? callRunningCallsCache : (snap.runningCalls || []);
			const text = extractPartialText(partial);
			if (text.trim()) callLastContentAt = Date.now();
			if (!text.trim()) {
				// 思考中:短暂无正文(>400ms)说"等一下"(只一次)。
				if (!callThinkingNotified && Date.now() - callLastContentAt > 400) {
					callThinkingNotified = true;
					callEnqueue(["等一下，我先想一下。"]);
				}
			} else {
				// 前缀去重:只读真正新增的完整句子。
				const prevText = callB1Processed;
				const commonLen = commonPrefixLength(text, prevText);
				const newText = text.slice(commonLen);
				if (newText.trim()) {
					const b1Segs = splitStreamSegments(newText);
					let lastEnd = commonLen;
					for (const seg of b1Segs) {
						if (callB1Seen.has(seg.segment)) continue;
						callB1Seen.add(seg.segment);
						callB1Chunk += seg.segment;
						lastEnd = commonLen + seg.end;
						if (callB1Chunk.length >= B1_CHUNK_MIN) {
							const c = callB1Chunk;
							callB1Chunk = "";
							callEnqueue([c]);
						}
					}
					if (lastEnd > callB1Spoken) callB1Spoken = lastEnd;
				}
				callB1Processed = text.slice(0, callB1Spoken);
			}
			// 收尾判定:任何 partial 状态(含 null=已完成)都评估;稳定 SETTLE_MS 后补"余句+收尾语"。
			const partialHasReasoning = (partial && partial.blocks && partial.blocks.some((b) => b.kind === "reasoning")) || false;
			const ready = !running && runningCalls.length === 0 && (partial === null || !partialHasReasoning);
			const clearSettle = () => { if (callSettleTimer !== null) { clearTimeout(callSettleTimer); callSettleTimer = null; } };
			if (!ready) { clearSettle(); return; }
			if (callSettleTimer !== null) return;
			const gen = callSettleGen;
			callSettleTimer = setTimeout(() => {
				callSettleTimer = null;
				if (gen !== callSettleGen || !callArmed) return;
				callFinalizeReading(snap);
			}, SETTLE_MS);
		}
		/** snapshot 订阅回调：检测 A 的新 user 节点(📞通话的语音输入)→武装；再驱动 B1。 */
		function callOnSnapshot() {
			if (callOwnerId == null) return;
			// 【挂断后仍念完当前条】挂断(callActive=false)只表示"不再采集新语音输入",但当前这条回复(已武装)
			// 要继续驱动念完(用户要求:挂断≠放弃这句,防误读只是挡"新输入")。
			// 所以这里不再用 callActive 一刀切 return;而是:callActive 只在"是否接受新 user 输入"上生效。
			const bind = sessionsRef?.binding(callOwnerId);
			const session = bind?.session;
			if (!session) return;
			const snap = session.getSnapshot();
			// 【DSH 0.1.2 兼容】新版 session.getSnapshot() 无 nodes;优先用 useChat 缓存(带 kind/seq),回退旧快照。
			const nodes = (callChatNodesCache && callChatNodesCache.length > 0) ? callChatNodesCache : (snap.nodes || []);
			let maxUser = -1;
			for (const n of nodes) if (n.kind === "user" && typeof n.seq === "number" && n.seq > maxUser) maxUser = n.seq;
			// 【挂断隔离新输入】只有"通话中(callActive)"才接受新 user 输入并武装;挂断后新说的话/环境声不当作你的输入。
			if (callActive && maxUser > callLastUserSeq && voiceInputIsCall && voiceInputSessionId === callOwnerId) {
				callLastUserSeq = maxUser;
				callArm(callOwnerId, maxUser);
			}
			// 【挂断后仍驱动当前条】只要"已武装(callArmed)",就继续 drive(念完当前这条;挂断 callActive=false 也照常)。
			callDriveOnSnapshot(snap);
		}
		/** 开📞：订阅通话归属会话 A 的 snapshot(常驻，切会话不丢)。 */
		function callEngineStart(ownerId) {
			logReadingStop("callEngineStart(重开📞) owner=" + ownerId);
			callOwnerId = ownerId;
			callActive = true;
			// 全局静音是【用户持久选择】,开/挂通话都不自动复位(按钮状态一目了然,不会误以为没声音)。
			const snap = sessionsRef?.binding(ownerId)?.session?.getSnapshot();
			// 【DSH 0.1.2 兼容】优先 useChat 缓存,回退旧快照。
			const nodes = (callChatNodesCache && callChatNodesCache.length > 0) ? callChatNodesCache : (snap?.nodes || []);
			let maxUser = -1;
			for (const n of nodes) if (n.kind === "user" && typeof n.seq === "number" && n.seq > maxUser) maxUser = n.seq;
			callLastUserSeq = maxUser;
			const bind = sessionsRef?.binding(ownerId);
			const session = bind?.session;
			if (!session) { console.warn("[dsh-voice] callEngineStart: no binding for", ownerId); return; }
			if (callUnsub) { try { callUnsub(); } catch {} }
			callUnsub = session.subscribe(() => { try { callOnSnapshot(); } catch (e) { console.warn("[dsh-voice] callEngine onSnapshot", e?.message); } });
		}
		/** 挂📞：退订(不再读新内容)；【不停当前语音】——让已入队/在播的念完或被用户打断才停。 */
		function callEngineStop() {
			if (callUnsub) { try { callUnsub(); } catch {} callUnsub = null; }
			callActive = false;
			// 【挂断语义·A】挂断=只"停止采集新语音输入"(callActive=false + 退订),【不清当前条、不停朗读】:
			// 当前这条回复(已武装)继续念完(即使念一半/还没开始)——用户要求"挂断≠放弃这句"。
			// callArmed 保留,让 callDriveOnSnapshot 仍能驱动当前条;只是不能再武装"新 user 输入"。
			callSettleGen += 1;
			if (callSettleTimer !== null) { clearTimeout(callSettleTimer); callSettleTimer = null; }
			if (activeReader === callReader) activeReader = null;
			callReader = null;
		}
		//#endregion
		/**
		* 【跨会话通话状态机】统一判断"某会话 X 能否使用语音入口(📞电话 / 🎤话筒)"。
		* 需求①②③④的判定核心,供 MicButton 与 TelButton 共用同一入口:
		*   - own_call  :有通话且归属=X → 可用(正常用,该打断打断)。
		*   - other_call:有通话但归属≠X → 不可用(提示占线,且音频输入要归到归属会话)。
		*   - own_busy  :无通话,但【当前会话自己】的语音还在播 → 可用(按下即打断,情况②式)。
		*   - voice_busy:无通话,但【别的会话】语音还在播(voiceBusy) → 需先确认"是否立即结束其它会话播报"。
		*   - free      :无通话且无播报 → 可用。
		* @param {string} sessionId 当前(查看中的)会话 id。
		* @returns {{canUse:boolean, situation:'own_call'|'other_call'|'own_busy'|'voice_busy'|'free', ownerSessionId:string|null}}
		*/
		function evaluateVoiceEntry(sessionId) {
			if (voiceCallActive && globalCallSessionId != null) {
				return globalCallSessionId === sessionId
					? { canUse: true, situation: "own_call", ownerSessionId: globalCallSessionId }
					: { canUse: false, situation: "other_call", ownerSessionId: globalCallSessionId };
			}
			if (voiceBusy) {
				// 语音还在播:若播报归属的就是当前会话 → 情况②(自己打断自己,直接可用);
				// 若归属别的会话 → 情况③(需先确认是否立即结束其它会话播报)。
				if (voiceBusySessionId != null && voiceBusySessionId === sessionId) {
					return { canUse: true, situation: "own_busy", ownerSessionId: null };
				}
				return { canUse: false, situation: "voice_busy", ownerSessionId: null };
			}
			return { canUse: true, situation: "free", ownerSessionId: null };
		}
		/** 长任务判定阈值:运行中但超过这么久没有新增正经文字,就认为在做耗时任务/长思考,进入等待态。 */
		const LONG_TASK_MS = 15000;
		/**
		* Split streamed reply text into speakable segments: completed sentences plus
		* delimiter-less runs past {@link STREAM_FLUSH_CHARS}. Each segment carries its
		* end offset in `text` so the caller can track how much has been handed to TTS
		* (the trailing incomplete sentence stays un-spoken and is re-evaluated later).
		*/
		function splitStreamSegments(text) {
			const result = [];
			const parts = text.match(/[^。！？!?…\n]+[。！？!?…\n]*/g) ?? [];
			let end = 0;
			for (const part of parts) {
				end += part.length;
				const trimmed = part.trim();
				if (trimmed.length === 0) continue;
				// 【原版·只读完整句】只保留"以句号/问号/感叹号结尾"或"≥30字"的段——这样"边生成边逐句念"
				// 只念完整句子,不会把 agent 写到一半的半截话当一句读出来,保住自然韵律(用户验证过的体验)。
				// (注:列表项漏读是次要问题,不为此放宽——否则半句会被提前读出,破坏韵律。)
				if (SENTENCE_END.test(trimmed) || trimmed.length >= STREAM_FLUSH_CHARS) {
					result.push({ segment: trimmed, end });
				}
			}
			return result;
		}
		/**
		* 把 LLM 回复文本转成"适合朗读的人话版"(仅用于语音朗读,不影响界面显示的文字)。
		* 基础过滤:去掉 markdown 符号、跳过代码块、去掉 URL/路径、压缩空白。
		* 专业词"人话化"暂不做(后逐步优化)。
		*/
		function toSpeechText(text) {
			if (!text) return "";
			let t = text;
			// 0) 优先提取 <speak>...</speak> 里的"对话式口语总结"(若有),语音只读这段;
			//    这实现"语音=口语总结、文字=完整内容"。若无 <speak>,回退处理全文。
			const m = t.match(/<speak>([\s\S]*?)<\/speak>/i);
			if (m && m[1] && m[1].trim().length > 0) {
				t = m[1];
			}
			// 1) 去掉 fenced 代码块 (```...```)
			t = t.replace(/```[\s\S]*?```/g, " ");
			// 2) 去掉行内代码 `code`
			t = t.replace(/`[^`]*`/g, " ");
			// 3) 去掉 URL(http/https/www)
			t = t.replace(/https?:\/\/\S+|www\.\S+/g, " ");
			// 4) 去掉常见 markdown 符号(#、*、-、_、|、>、=、标点装饰) —— 保留中英文正文和基础标点
			t = t.replace(/[#*_`|>~]{1,}/g, " ");
			t = t.replace(/^[=\-]{3,}$/gm, " ");
			// 4b) 去掉表情符号/emoji 及非必要特殊字符(避免语音把表情/符号念出来)
			t = t.replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2700}-\u{27BF}]/gu, " ");
			// 4c) 符号口语化:把 TTS 易读错的符号换成正常中文念法(如 "/" 被念成"美"、&、+、% 等),避免乱码。
			t = t.replace(/\//g, "、");
			t = t.replace(/\\/g, "、");
			t = t.replace(/&/g, "和");
			t = t.replace(/\+/g, "加");
			t = t.replace(/%/g, "百分之");
			t = t.replace(/=/g, "等于");
			t = t.replace(/</g, "小于");
			// 5) 去掉多余空白(含换行压成空格)
			t = t.replace(/\s+/g, " ").trim();
			return t;
		}
		/**
		* 把 <speak>...</speak> 标记去掉。分段总结时,不该把 agent 自己写的口语总结再当
		* 正文喂给 /voice/summarize(避免"总结的总结"),所以先把这段占位内容剔除。
		*/
		function stripSpeak(text) {
			return text.replace(/<speak>[\s\S]*?<\/speak>/gi, " ");
		}
		/**
		* 把一段较长文字拆成不超过 max 字符的多段,用于"分段总结"。
		* 优先按【段落(换行/空行)】切——段落是完整的语义块,能避免把同一话题切到两段、
		* 造成"下一段接着上段尾巴又没接好"的衔接问题;段落太长再按句中句号切。
		*/
		function splitTextByBoundary(text, max) {
			const chunks = [];
			// 1) 先按段落/换行切成"语义块"(每个块尽量是完整话题)。
			const paragraphs = text.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
			for (const para of paragraphs) {
				if (para.length <= max) {
					chunks.push(para);
				} else {
					// 2) 段落太长:再按中文句号/问号/感叹号切,尽量留在完整句子上。
					let cur = "";
					const sentences = para.match(/[^。！？!?…]+[。！？!?…]*/g) ?? [para];
					for (const raw of sentences) {
						const seg = raw.trim();
						if (!seg) continue;
						if (cur.length + seg.length > max && cur.length > 0) {
							chunks.push(cur.trim());
							cur = seg;
						} else {
							cur += seg;
						}
					}
					if (cur.trim()) chunks.push(cur.trim());
				}
			}
			const out = chunks.filter((c) => c.trim().length > 0);
			return out.length > 0 ? out : [text.trim()];
		}
		/** 判断一行是否是"列表/编号"要点的起始(真·点边界)。标题/加粗大标题是结构,不算"点"(否则会把标题当成一个点,N 数错)。 */
		function isPointStartLine(line) {
			if (!line) return false;
			return /^\s*(?:\d+[.、)）]|[一二三四五六七八九十]+[.、．]|[①②③④⑤⑥⑦⑧⑨⑩]|[-*•▪])\s+/.test(line);
		}
		/**
		* 按"列表/编号"结构把文字切成一串原子要点。若整段没有任何点标记(纯段落/连续文字),
		* 返回 null,便于调用方退回原"段落/句"切分。每个点都是完整单元,不拆开。
		* 【关键】标题/前言不当作独立"点":把它们并入第一个点当作开头,避免把要点总数 N 数成 N+1、
		* 导致"第x~y点共N点"序号错位、总结漏点/重复。
		*/
		function splitByPoints(text) {
			const lines = text.split(/\r?\n/);
			const points = [];
			let cur = [];
			let sawMarker = false;
			let preamble = [];
			const flush = () => { if (cur.length) { points.push(cur.join(" ")); cur = []; } };
			for (const raw of lines) {
				const line = raw.trim();
				if (!line) { if (sawMarker) flush(); continue; }
				if (isPointStartLine(line)) { sawMarker = true; flush(); cur = [line]; }
				else { if (sawMarker) cur.push(line); else preamble.push(line); }
			}
			flush();
			if (!sawMarker) return null;
			if (preamble.length && points.length) points[0] = preamble.join(" ") + "\n" + points[0];
			return points;
		}
		/**
		* 把原子要点按"单段总结上限(约 maxChars 源文字)"分组。每组是一批**完整**要点:
		* 不把某个点拆到两组、不重复、不漏点。返回 [{items, start, end}],start/end 为 0 基的下标。
		*/
		function groupByPoints(points, maxChars) {
			const groups = [];
			let cur = [];
			let curStart = 0;
			for (let i = 0; i < points.length; i++) {
				const p = points[i];
				if (cur.length === 0) curStart = i;
				const curLen = cur.reduce((s, x) => s + x.length, 0);
				if (cur.length > 0 && curLen + p.length > maxChars) {
					groups.push({ items: cur, start: curStart, end: i - 1 });
					cur = []; curStart = i;
				}
				cur.push(p);
				const _len = cur.reduce((s, x) => s + x.length, 0);
				if (_len > maxChars) { groups.push({ items: cur, start: curStart, end: i }); cur = []; }
			}
			if (cur.length) groups.push({ items: cur, start: curStart, end: points.length - 1 });
			return groups;
		}
		/** Length of the longest common prefix of two strings. */
		function commonPrefixLength(left, right) {
			const max = Math.min(left.length, right.length);
			let i = 0;
			while (i < max && left.charCodeAt(i) === right.charCodeAt(i)) i++;
			return i;
		}
		/**
		* The mic control. `useInput`/`useSession`/`inputActions` come from the
		* conversation standard kit; `language`/`interimResults` come from the
		* plugin's injected config face.
		*/
		function MicButton({ useInput, useSession, useChat, inputActions, t, language, interimResults, cancel, sessionId }) {
			const draft = useInput((state) => state?.draft ?? "");
			// 【DSH 0.1.2 兼容】新版 useSession 返回 SessionSnapshot(无 chat.legacy.nodes);
			// 聊天节点列表(带 kind/seq)在新版由 useChat 提供(s.legacy.nodes)。优先用 useChat,缺失回退 useSession。
			const chatNodes = (useChat && typeof useChat === "function")
				? useChat((state) => state?.legacy?.nodes ?? [])
				: useSession((state) => state?.chat?.legacy?.nodes ?? []);
			const chatNodesRef = (0, react.useRef)(chatNodes);
			chatNodesRef.current = chatNodes;
			const [micState, setMicState] = (0, react.useState)("idle");
			const [readingReply, setReadingReply] = (0, react.useState)(false);
			/** 【跨会话通话状态机·voiceBusy】readingReply 的 ref 镜像:用于在事件回调(非渲染)里同步读取
			* "是否正在朗读",避免闭包抓到旧 state。由 finishReading/enqueueReplySegments 同步更新。 */
			const readingReplyRef = (0, react.useRef)(false);
			const recRef = (0, react.useRef)(null);
			/** MediaRecorder controller for the "press-and-hold to talk" mode (local whisper STT). */
			const mediaRecorderRef = (0, react.useRef)(null);
			const monitoringRef = (0, react.useRef)(false);
			const baseRef = (0, react.useRef)("");
			const accRef = (0, react.useRef)(new TranscriptAccumulator());
			const holdTimerRef = (0, react.useRef)(null);
			const holdingRef = (0, react.useRef)(false);
			const wasListeningRef = (0, react.useRef)(false);
			const setByUsRef = (0, react.useRef)(false);
			const lastDraftRef = (0, react.useRef)("");
			const chatArmedRef = (0, react.useRef)(false);
			const replySeqRef = (0, react.useRef)(-1);
			// 【全局📞】"已处理到哪条 user 节点"按会话记录:已提升到【模块级】lastUserSeqBySession(见上)，
			// 组件重挂(切走/切回)不清空 → 历史消息不会被误判为"新语音输入"而误触发重武装/打断。
			const micUsedAtRef = (0, react.useRef)(0);
			const speakerRef = (0, react.useRef)(null);
			if (speakerRef.current === null) speakerRef.current = createReplySpeaker();
			/** 【全局📞】朗读当前武装/归属的会话 id(null=尚未武装)。A 的通话朗读绑定 A;切到 B 时它仍是 A,
			* 朗读绝不读 B(其它会话的 partial/chatNodes 被丢弃);切回 A 继续,只有真正挂断才停。 */
			const armedSessionRef = (0, react.useRef)(null);
			/** 【📞B1】当前武装的这条回复是否走"📞边生成边逐句念"(true=通话;false=话筒/文字走"每10秒总结")。
			* 在武装时按"最近一次输入是不是📞"记下,避免"话筒按住说"被误用成通电话的 B1。 */
			const replyIsCallRef = (0, react.useRef)(false);
			/** 本组件当前绑定的会话 id:用于检测"切换会话"(切走不停止朗读,只初始化新会话基线防串读)。 */
			const lastSessionRef = (0, react.useRef)(sessionId);
			/** Stop the live recognizer and suppress its handlers, leaving monitoring state intact. */
			const pauseRecognizer = () => {
				const rec = recRef.current;
				recRef.current = null;
				if (rec !== null) {
					rec.onend = () => {};
					rec.onerror = () => {};
					rec.stop();
				}
			};
			/** The streaming reply partial, subscribed so reply reading starts while the model is still generating. */
			// 【DSH 0.1.2 兼容】partial/runningCalls 新版 useSession(SessionSnapshot) 已无(在 useChat legacy);优先 useChat,回退 useSession。
			const partial = (useChat && typeof useChat === "function")
				? (useChat((state) => state?.legacy?.partial ?? null) ?? null)
				: useSession((state) => state?.partial ?? null);
			/** Whether the current reply is still generating (drives分段 vs 完整收尾的判断). */
			const running = useSession((state) => state?.running ?? false);
			/** 当前正在运行的工具调用(如 pwsh 等)。非空=agent 还在跑工具,任务未完成。 */
			const runningCalls = (useChat && typeof useChat === "function")
				? (useChat((state) => state?.legacy?.runningCalls ?? []) ?? [])
				: useSession((state) => state?.runningCalls ?? []);
			/** Whether reading paused a live recognizer (so stopping reading must resume it). */
			const readingPausedRef = (0, react.useRef)(false);
			/** Reply segments queued for sequential reading. */
			const ttsQueueRef = (0, react.useRef)([]);
			/** Whether a segment is currently being read (serializes the queue). */
			const ttsSpeakingRef = (0, react.useRef)(false);
			/** 【跨会话通话状态机·voiceBusy】同步模块级 voiceBusy = 正在朗读 || 队列还有未播 || speaker 在播。
			* 在读/播/停的关键点调用,让"别的会话"能实时读到"归属会话的语音是否还在播"(情况③的判定依据)。
			* 同时把 voiceBusySessionId 记成"播报归属的那个会话"(armedSessionRef),用于区分"自己打断自己" vs "别的会话在播"。
			* 只写模块级变量,不改动朗读队列本身(不破坏 B1/去重/分块/打断)。 */
			const syncVoiceBusy = () => {
				const busy = readingReplyRef.current
					|| (ttsQueueRef.current?.length ?? 0) > 0
					|| !!(speakerRef.current && speakerRef.current.speaking);
				voiceBusy = busy;
				voiceBusySessionId = busy ? (armedSessionRef.current ?? null) : null;
			};
			/** The streamed text already handed to TTS; trailing incomplete sentences are intentionally excluded. */
			const ttsSpokenPrefixRef = (0, react.useRef)("");
			/** Whether the reply has finalized (so a drained queue means reading is done). */
			const ttsFinalizedRef = (0, react.useRef)(false);
			/** 分段总结:已总结并交给 TTS 朗读的文字长度偏移(此前缀不再重复朗读,避免丢后面)。 */
			const summaryOffsetRef = (0, react.useRef)(0);
			/** 【B1】📞边生成边逐句念:已念到的文字偏移(只用于📞;话筒/文字不启用)。 */
			const b1SpokenRef = (0, react.useRef)(0);
			/** 【B1】是否已对当前回复说过"等一下"(思考即时提示,只一次;回复中途不重置)。 */
			const b1ThinkingNotifiedRef = (0, react.useRef)(false);
			/** 【B1】本轮已念过的句子集合:内容去重,防止 agent 生成重复/流式重吐导致同一句反复念。 */
			const b1SeenRef = (0, react.useRef)(new Set());
			/** 【B1】上一次处理过的 partial 文本:用于"前缀去重"(找公共前缀,只读真正新增的部分,防重叠/重发)。 */
			const b1ProcessedRef = (0, react.useRef)("");
			/** 【B1】自然韵律:把 2~3 句攒成一个块再合成,避免逐句导致每句韵律独立、断句生硬。 */
			const b1ChunkRef = (0, react.useRef)("");
			/** 最近一次触发分段总结的时间戳,用于边界(时间/字数)判断。 */
			const lastSummaryAtRef = (0, react.useRef)(0);
			/** 序列化总结链:保证多段总结按原文顺序朗读,且最终收尾总结排在最后(不乱序)。 */
			const summaryChainRef = (0, react.useRef)(Promise.resolve());
			/** 本轮回复是否已做过最终收尾总结(避免重复触发)。 */
			const summaryDoneRef = (0, react.useRef)(false);
			/** 当前用户问的问题(最近一条 user 消息的文字),供总结"扣题"用。 */
			const userQuestionRef = (0, react.useRef)("");
			/** 回复代号:每次 armReplyReading(新回复) +1。用于丢弃"上一轮"仍在途的总结结果。 */
			const voiceGenRef = (0, react.useRef)(0);
			/** 最近一次"流式出现新正文"的时间戳。用于检测长时间无正文=在做长任务/长思考。 */
			const lastContentAtRef = (0, react.useRef)(Date.now());
			/** 是否处于"长任务等待态"(true=这段期间不再调 /voice/summarize 总结,避免烧 API)。 */
			const taskBackoffRef = (0, react.useRef)(false);
			/** 本轮是否已经播过"长任务等待提示"(每轮只播一次,避免重复)。 */
			const taskNotifiedRef = (0, react.useRef)(false);
			/** 收尾稳定期定时器 id(1.5s 稳定后才做完整收尾总结)。 */
			const settleTimerRef = (0, react.useRef)(null);
			/** 收尾代号:每次新回复 +1,用于作废旧的稳定期定时器(避免收尾落到旧回复上)。 */
			const settleGenRef = (0, react.useRef)(0);
			/** A stop-tap on the mic consumes its pointer-up (no toggle/monitoring side effects). */
			const stopTapRef = (0, react.useRef)(false);
			/** End reply reading (naturally or by user stop): clear state and resume monitoring if paused. */
			const finishReading = () => {
				// 【门控复位】朗读真正结束(播完/被停/被打断)时,立即把 chatArmedRef 复位为 false。
				// 之前它只在 settle 定时器回调里复位:凡是"朗读结束但没走完那条路径"(如打断/barge-in、
				// STT 空文本没提交、回复被取消未提交)都会留下 chatArmedRef=true 残留,
				// 之后 settle effect 会把"最近一条 assistant 回复"当成待读又念一遍 —— 这就是修复点。
				chatArmedRef.current = false;
				readingReplyRef.current = false;
				setReadingReply(false);
				// 【跨会话打断】朗读真正结束(播完/被停/被打断)→ 注销 activeReader,免得后来打断误停"已结束朗读"的会话。
				if (activeReader && activeReader.sessionId === sessionId) activeReader = null;
				syncVoiceBusy();
				if (readingPausedRef.current) {
					readingPausedRef.current = false;
					if (monitoringRef.current) startRecognizer();
				}
			};
			/** Speak queued segments one at a time; once the queue drains after the reply finalizes, finish. */
			const pumpQueue = () => {
				const sp = speakerRef.current;
				if (sp === null || ttsSpeakingRef.current) return;
				const segment = ttsQueueRef.current.shift();
				if (segment === void 0) {
					if (ttsFinalizedRef.current) finishReading();
					return;
				}
				ttsSpeakingRef.current = true;
				sp.onend = () => {
					ttsSpeakingRef.current = false;
					syncVoiceBusy();
					pumpQueue();
				};
				sp.speak(segment);
				syncVoiceBusy();
			};
			/** Queue reply segments for reading; pause recognition on the first so the reply is not echoed. */
			const enqueueReplySegments = (segments) => {
				for (const segment of segments) {
					const s = toSpeechText(segment);
					if (s.length > 0) ttsQueueRef.current.push(s);
				}
				if (ttsQueueRef.current.length === 0) return;
				if (!readingPausedRef.current) {
					const wasMonitoring = monitoringRef.current;
					if (wasMonitoring) pauseRecognizer();
					readingPausedRef.current = wasMonitoring;
				}
				readingReplyRef.current = true;
				setReadingReply(true);
				syncVoiceBusy();
				pumpQueue();
			};
			/** Stop the in-flight reply reading (user taps the mic while it reads). */
			const stopReading = () => {
				ttsQueueRef.current = [];
				ttsFinalizedRef.current = true;
				// 复位"正在朗读":否则打断后 ttsSpeakingRef 卡 true,pumpQueue 一直 return,
				// 导致之后 AI 新回复不再朗读(打断后语音消失) —— 只补这一处,不动其它。
				ttsSpeakingRef.current = false;
				speakerRef.current?.stop();
				// 用户手动打断/停止朗读:作废可能还挂着的收尾稳定期定时器,避免打断后仍收尾出引导语。
				settleGenRef.current += 1;
				if (settleTimerRef.current !== null) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
				// 【打断修复】同时作废 voiceGen 并重置总结链:丢弃"还在途中的分段总结"结果,
				// 否则这些总结返回后会重新入队,朗读又接着播,导致"打断不了"。这是打断能否彻底停住的关键。
				voiceGenRef.current += 1;
				summaryChainRef.current = Promise.resolve();
				b1ChunkRef.current = ""; // 打断时清空 B1 攒句,避免残句再念
				finishReading();
			};
			// 【barge-in】话筒注册"打断"处理器给📞按钮用:检测到用户开口时立即停朗读+取消生成(不等他说完)。
			// 【全局驱动·打断归属(B 要求)】打断一律按"全局通话状态"判:只要 voiceCallActive && globalCallSessionId!=null,
			// 打断就只落在"通话归属会话(A)"上 —— 取 activeReader(且仅当其 sessionId===globalCallSessionId)停
			// A 的 speaker/队列/在途总结、cancel A 的生成;绝不用【当前会话】的 cancel/stopReading 兜底。
			// 否则"做文字任务时说话"会误打断【当前任务会话】而非 A。只有【无全局通话】时才退回旧行为
			// (自聊/普通打断用当前会话的 cancel+stopReading 兜底)。
			voiceInterruptHandler = () => {
				if (voiceCallActive && globalCallSessionId != null) {
					const r = activeReader;
					if (r && r.sessionId === globalCallSessionId) {
						try { r.cancel && r.cancel(); } catch {}
						try { r.stop && r.stop(); } catch {}
					}
					// 【barge-in 兜底】即使 activeReader 未对上，只要📞通话在跑，也直接停掉常驻引擎的朗读，
					// 确保"你一张口、语音立即停"（不等说完）。绝不误停当前/任务会话（有 globalCallSessionId 门控）。
					try { if (typeof callStopReading === "function") callStopReading(); } catch {}
					return;
				}
				const r = activeReader;
				if (r) {
					try { r.cancel && r.cancel(); } catch {}
					try { r.stop && r.stop(); } catch {}
				} else {
					try { cancel?.(); } catch {}
					try { stopReading(); } catch {}
				}
			};
			// 【📞挂断】注册"挂断即停朗读"处理器(只停朗读,不取消 agent 生成):只有真正把📞挂断才停,切会话不停。
			// 【全局驱动·停读归属(B 要求)】有全局通话时,停读也只认"通话归属会话(A)"的朗读资源
			// (activeReader.sessionId===globalCallSessionId),绝不用【当前会话】的 stopReading 兜底
			// (避免切到别的会话时误停那个会话的朗读)。【无全局通话】时退回旧行为(可停当前/归属朗读)。
			voiceStopReadingHandler = () => {
				if (voiceCallActive && globalCallSessionId != null) {
					const r = activeReader;
					if (r && r.sessionId === globalCallSessionId) {
						try { r.stop && r.stop(); } catch {}
					}
					return;
				}
				const r = activeReader;
				if (r) {
					try { r.stop && r.stop(); } catch {}
				} else {
					try { stopReading(); } catch {}
				}
			};
			// 【会话切换:不停止朗读】切到别的会话时【不再 resetReadState】。之前"切会话就复位+停朗读"的
			// 方向是错的:它会把"A 发起的那通📞"在切走时掐断(切到 B 去查东西,A 就停了)。
			// 改为:只在进入"新会话"时,把该会话"已处理 user 节点"基线设成它当前已存在的最新一条,
			// 使这个会话(以及任何会话)的【历史回复】不会被当成"新语音输入"而自动朗读(防切会话串读)。
			// A 的朗读状态(armedSessionRef/各 offset/speaker 队列)原样保留,切回 A 时继续;
			// 只有真正"挂断电话"才停 A。
			(0, react.useEffect)(() => {
				if (sessionId === lastSessionRef.current) return;
				lastSessionRef.current = sessionId;
				const nodes = chatNodesRef.current || [];
				let maxUser = -1;
				for (const n of nodes) {
					if (n && n.kind === "user" && typeof n.seq === "number" && n.seq > maxUser) maxUser = n.seq;
				}
				lastUserSeqBySession[sessionId] = maxUser;
			}, [sessionId]);
			(0, react.useEffect)(() => {
				// 【📞防无按钮自动采集】记录"当前正在查看的会话 id",供 TelButton 的 /voice/stream turn
				// 自动提交门控用:只有正在看通话归属会话时才自动接话;切到别的会话就丢弃 turn。
				currentViewSessionId = sessionId;
			}, [sessionId]);
			/** 标记本轮回复朗读已收尾:置 finalized,若队列已空且没在播则立即结束。 */
			const finalizeReading = () => {
				ttsFinalizedRef.current = true;
				summaryDoneRef.current = true;
				if (ttsQueueRef.current.length === 0 && !ttsSpeakingRef.current) finishReading();
			};
			/**
			* 对单一段文字调 /voice/summarize 转成口语总结并入队朗读。
			* @param {string} chunk 单段源文本。
			* @param {boolean} chunkIsFinal 该段是否最终收尾(带引导句);分段总结传 false。
			* @returns {Promise<boolean>} 是否成功入队朗读了一段总结。
			*/
			const summarizeSingle = (chunk, chunkIsFinal, scope) => {
				const clean = stripSpeak(chunk).trim();
				if (!clean) return Promise.resolve(false);
				// 记录当前回复代号:若总结返回时已进入新回复(用户打断/新发言),丢弃这条过期总结。
				const gen = voiceGenRef.current;
				const run = summaryChainRef.current.then(() =>
					fetch("/voice/summarize", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ text: clean, final: !!chunkIsFinal, question: userQuestionRef.current || undefined, scope: scope || undefined }),
					})
						.then((r) => { if (!r.ok) throw new Error(`summarize ${r.status}`); return r.json(); })
						.then((j) => {
							if (gen !== voiceGenRef.current) return false;
							let s = (j.text || "").trim();
							// 本段为最终收尾时兜底补引导语;分段总结不带。
							if (chunkIsFinal && s.length > 0 && !s.includes(GUIDING_SENTENCE)) s = s + " " + GUIDING_SENTENCE;
							if (s.length > 0) { enqueueReplySegments([s]); return true; }
							return false;
						})
						.catch((e) => {
							if (gen !== voiceGenRef.current) return false;
							console.warn("[dsh-voice] summarize failed, fallback to filtered text", e?.message);
							let s = toSpeechText(clean);
							if (chunkIsFinal && s.length > 0 && !s.includes(GUIDING_SENTENCE)) s = s + " " + GUIDING_SENTENCE;
							if (s.length > 0) { enqueueReplySegments([s]); return true; }
							return false;
						})
				);
				summaryChainRef.current = run.catch(() => false);
				return run;
			};
			/**
			* 把一段文字经 /voice/summarize 转成"对话式口语总结"并入队朗读。
			* 【A+B 拆分】若文字较长,按句切成多段(≤SUMMARIZE_CHUNK_MAX),每段单独调一次 GPT 总结,
			* 保证每段总结不超长(≤150字、音频不超时),朗读更稳;中间段均不带引导语。
			* @param {string} text 要总结的文字(可含 markdown/代码,交给 LLM 提炼)。
			* @param {boolean} isFinal true=最终收尾:所有分段总结之后,再单独补一句收尾(带引导语);
			*                          false=中间分段(只做分段总结,不带引导语)。
			* @returns {Promise<boolean>} 是否成功入队朗读了一段总结。
			*/
			const summarizeToSpeech = (text, isFinal) => {
				// 【B】若回复含完整 <speak> 口语总结,直接读它(跳过 /voice/summarize 二次总结,延迟低)
				const sm = text.match(/<speak>([\s\S]*?)<\/speak>/i);
				if (sm && sm[1] && sm[1].trim()) {
					const s = toSpeechText(sm[1]);
					if (s) { enqueueReplySegments([s]); return Promise.resolve(true); }
				}
				const clean = stripSpeak(text).trim();
				if (!clean) return Promise.resolve(false);
				const gen = voiceGenRef.current;
				// 【语义完整分段】优先按"要点/列表/标题"结构切成完整点组:每组是完整的一批要点,
				// 不把一个点拆到两段、不重复、不漏点;若整段无点结构,退回原"段落/句"切分(原逻辑)。
				const pointList = splitByPoints(clean);
				let groups = [];
				if (pointList && pointList.length) {
					groups = groupByPoints(pointList, SUMMARIZE_CHUNK_MAX).filter((g) => g.items && g.items.length);
				} else {
					groups = splitTextByBoundary(clean, SUMMARIZE_CHUNK_MAX).map((c) => ({ items: [c], start: -1, end: -1 }));
				}
				const total = pointList ? pointList.length : 0;
				let p = Promise.resolve(true);
				// A+B 拆分:逐组串行总结(每段均不带引导语),顺序由 summaryChain 保证。
				groups.forEach((g) => {
					const chunkText = g.items.join("\n");
					const scope = (total > 0 && g.start >= 0 && g.end >= g.start) ? `${g.start + 1}~${g.end + 1}点，共${total}点` : "";
					p = p.then(() => summarizeSingle(chunkText, false, scope));
				});
				// 最终收尾:所有分段总结之后,再单独补一句收尾(带引导语),只在整条回复真正完结时播。
				if (isFinal) {
					p = p.then(() => {
						if (gen !== voiceGenRef.current) return false;
						const s = toSpeechText(CLOSING_TEXT);
						if (s.length > 0) { enqueueReplySegments([s]); return true; }
						return false;
					});
				}
				return p;
			};
			(0, react.useEffect)(() => {
				// 【📞常驻引擎单点门控】本会话处于"📞通话模式"(最近一次语音输入是📞且归属本会话)时,朗读由常驻引擎独占,
				// MicButton 不再读(防双读)。话筒/文字(voiceInputIsCall=false)时此门控关闭,走原"每10秒总结"路径,不受影响。
				if (voiceInputIsCall && voiceInputSessionId === sessionId) return;
				// 【分段总结】流式进行中(armed 且 running):每到一个边界(时间/字数)把新累积的文字
				// 总结成一段口语总结并朗读。是否完结由 running 决定:
				//   - 未完结 → 总结当前分段并继续累积(不丢后续);
				//   - 完结   → 由下方 chatNodes 收尾,对剩余"后半段"做一次完整收尾总结。
				// 朗读不打断、不丢后半段:分段总结只推进 summaryOffset,留给收尾剩余的完整内容。
				// 【全局📞】朗读只认"武装归属的那个会话"。若当前查看的是别的会话(如 A 在通话、正在看 B),
				// 就不要用 B 的 partial 去推进/分段总结(否则会把 B 的内容读掉)—— A 的朗读状态原样保留,
				// 切回 A 继续。
				if (armedSessionRef.current !== sessionId) return;
				if (!chatArmedRef.current) return;
				if (summaryDoneRef.current) return;
				const now = Date.now();
				const text = extractPartialText(partial);
				// 流式只要出现新的正式正文,就刷新"最近有正文"的时间戳。
				if (text.trim()) lastContentAtRef.current = now;
				// 【长任务判定】还有在途流式内容(partial !== null,即在 thinking/生成中)、且超过
				//   LONG_TASK_MS 没有新正文 → 判定在做耗时任务/长思考。此时进入"等待态":
				//   ① 若还没提示过,就朗读"接下来要执行耗时任务,请稍等"告知用户(别让他干等);
				//   ② 等待态期间【不调 /voice/summarize 总结】,省 API 费用;直到任务产出结果正文才恢复。
				// 用 partial!==null(而非 running)作判定,是因为 thinking 时 running 可能为 false,
				// 但 partial 仍有 reasoning 内容,用它能正确识别"还在工作中"。长任务期间绝不每 5 秒调总结。
				if (partial !== null && now - lastContentAtRef.current > LONG_TASK_MS) {
					if (!taskNotifiedRef.current) {
						taskNotifiedRef.current = true;
						taskBackoffRef.current = true;
						const waitMsg = "稍等一下，我在思考。";
						const run = summaryChainRef.current.then(() => {
							const s = toSpeechText(waitMsg);
							if (s.length > 0) enqueueReplySegments([s]);
							return true;
						});
						summaryChainRef.current = run.catch(() => false);
					}
					return; // 长任务等待态:不总结、不调 API
				}
				// 已在长任务等待态:只有出现足够多的新正文(任务已开始产出结果)才退出等待态、
				// 恢复"每 5 秒分段总结";否则(仍无正文、仍在思考/等待)继续等待、不总结、不调 API。
				// 这样长任务完成、模型开始输出结果后,结果会被正常逐段总结并播报,不会漏掉。
				if (taskBackoffRef.current) {
					const backOffset = summaryOffsetRef.current;
					const backFresh = backOffset < text.length ? text.slice(backOffset) : "";
					if (backFresh.length < SEGMENT_SUMMARY_MIN_CHARS) return;
					taskBackoffRef.current = false; // 结果正文开始出现,退出等待态,恢复分段总结
				}
				// 【B1】📞电话通话:边生成边逐句念 —— 每出现一个完整句子/长句,立刻整句合成+朗读(非流式,干净)。
				// 只作用"本条回复确实由📞发起"(replyIsCallRef=true) —— 话筒/文字走下方原"每10秒总结"逻辑,不受影响。
				if (replyIsCallRef.current) {
					// 📞：若 agent 还在思考/尚无正文,短暂思考(>400ms)后立刻说"等一下",给用户即时反馈;只一次。
					if (!text.trim()) {
						if (!b1ThinkingNotifiedRef.current && now - lastContentAtRef.current > 400) {
							taskNotifiedRef.current = true; // 已用"等一下"提示,避免 15s 长任务话术再冒一次
							b1ThinkingNotifiedRef.current = true;
							enqueueReplySegments(["等一下，我先想一下。"]);
						}
						return;
					}
					// 【前缀去重(正解)】找"已处理文本"与当前 text 的公共前缀 → 只读公共前缀**之后真正新增**的完整句子。
					// 这样无论 partial 是单调增长、还是重叠/重发(流式重复快照),都不会把已念的部分再念一遍。
					// 注意:b1ProcessedRef 只存"已读到的最新结束偏移"对应的文本,未完成的尾句不算已处理,
					// 下次它补完时会作为"新增"被读到(不会漏)。
					const prevText = b1ProcessedRef.current;
					const commonLen = commonPrefixLength(text, prevText);
					const newText = text.slice(commonLen);
					if (newText.trim()) {
						const b1Segs = splitStreamSegments(newText);
						let lastEnd = commonLen;
						for (const seg of b1Segs) {
							// 【内容去重】本轮已念过这句(哪怕 agent 生成里重复)就跳过。
							if (b1SeenRef.current.has(seg.segment)) continue;
							b1SeenRef.current.add(seg.segment);
							// 攒块(自然韵律):把句子累进 chunk,攒够 B1_CHUNK_MIN 字就整块合成/朗读。
							b1ChunkRef.current += seg.segment;
							lastEnd = commonLen + seg.end;
							if (b1ChunkRef.current.length >= B1_CHUNK_MIN) {
								const c = b1ChunkRef.current;
								b1ChunkRef.current = "";
								enqueueReplySegments([c]);
							}
						}
						if (lastEnd > b1SpokenRef.current) b1SpokenRef.current = lastEnd;
					}
					b1ProcessedRef.current = text.slice(0, b1SpokenRef.current); // 已处理到最新朗读位置
					// 末尾不足一块的余句,先不念,交收尾一起补(避免碎块)。
					return;
				}
				if (!running) return;
				// 【关键】先判断"当前流式输出有没有可总结的正文内容"再决定是否总结:
				//   - partial 里只有 thinking/reasoning(块 kind != 'text')时,extractPartialText 返回 "",
				//     说明模型还在思考、无正文 → 直接返回,不去总结空内容;
				//   - 一旦出现正文(text 块非空/非空白),才进入后续边界判断。
				// 这样"模型一直在 thinking、没输出"时绝不会触发空总结,也就不会念出废话。
				if (!text.trim()) return;
				const total = text.length;
				// 新回复(文字比上次短)则重置分段进度。
				if (total < summaryOffsetRef.current) {
					summaryOffsetRef.current = 0;
					lastSummaryAtRef.current = Date.now();
				}
				const offset = summaryOffsetRef.current;
				if (offset >= total) return;
				const fresh = text.slice(offset);
				if (!fresh.trim()) return;
				const timeUp = now - lastSummaryAtRef.current >= SEGMENT_SUMMARY_MS;
				// 边界=时间为主:每隔约 SEGMENT_SUMMARY_MS 才总结一次(避免长回复被碎成几十段)。
				// 字数下限只是"太碎就别总结":新文字不足就留给下一个边界或最终收尾,不会丢。
				if (!timeUp) return;
				if (fresh.length < SEGMENT_SUMMARY_MIN_CHARS) return;
				// 立即推进偏移(本段已被拿去总结,不再重读);新增文字会被下一个边界接上。
				summaryOffsetRef.current = total;
				lastSummaryAtRef.current = now;
				summarizeToSpeech(fresh, false);
			}, [partial, running]);
			/**
			* Arm reply reading: only the assistant reply arriving after the current
			* maximum assistant seq will be spoken (baseline from nodes strictly before
			* `afterSeq`, so a same-batch reply is not skipped).
			*/
			const armReplyReading = (afterSeq, isCall) => {
				replySeqRef.current = chatNodesRef.current.reduce((max, node) => node.kind === "assistant" && node.seq < afterSeq ? Math.max(max, node.seq) : max, -1);
				chatArmedRef.current = true;
				// 【根因修复】每次武装新回复时,必须把"已读完"标记重置回 false。
				// 原来 ttsFinalizedRef 只在某次朗读结束(收尾)时置 true、从不回 false → 残留 true。
				// 导致下一次朗读进行中,队列短暂为空(还在攒下一句)时被误判"已读完" → 提前 finishReading,
				// 把 agent 还在生成、还没念的句子丢弃 → "后面不念"。每轮按 false 起步才正确。
				ttsFinalizedRef.current = false;
				// 【📞B1】按"最近一次输入是不是📞"记下本条回复的朗读模式(通话→边生成边逐句念;话筒→每10秒总结)。
				replyIsCallRef.current = !!isCall;
				// 【全局📞】记录"朗读归属的会话":A 的通话朗读绑定 A;切到 B 时它仍是 A,
				// 让下面的"推进/收尾"effect 都不去处理别的会话的内容(绝不再读别的会话)。
				armedSessionRef.current = sessionId;
				// 【跨会话打断】登记"正在朗读"的会话(归属会话)及其朗读资源闭包:
				// 打断时(无论当前在看哪个会话)据此定位归属会话 A 的 stop/cancel,停 A 的朗读而不误停别的会话。
				activeReader = {
					sessionId,
					stop: () => { try { stopReading(); } catch {} },
					cancel: () => { try { cancel && cancel(); } catch {} },
				};
				// 新回复:重置分段总结进度(从 0 开始累计,避免沿用上一轮偏移导致丢内容)。
				summaryOffsetRef.current = 0;
				b1SpokenRef.current = 0;
				b1ThinkingNotifiedRef.current = false;
				b1SeenRef.current = new Set();
				b1ProcessedRef.current = "";
				b1ChunkRef.current = "";
				// 首段也等满一个边界(约 SEGMENT_SUMMARY_MS),这样短回复只走一次完整总结,不碎。
				lastSummaryAtRef.current = Date.now();
				summaryChainRef.current = Promise.resolve();
				summaryDoneRef.current = false;
				voiceGenRef.current += 1;
				// 新回复:长任务等待态复位(从正常分段总结节奏开始)。
				lastContentAtRef.current = Date.now();
				taskBackoffRef.current = false;
				taskNotifiedRef.current = false;
				// 新回复:作废可能残留的旧稳定期定时器,并清空。
				settleGenRef.current += 1;
				if (settleTimerRef.current !== null) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
			};
			(0, react.useEffect)(() => {
				if (draft === lastDraftRef.current) return;
				if (!setByUsRef.current) {
					baseRef.current = draft;
					accRef.current.reset();
					if (monitoringRef.current) restartRecognizer();
				}
				lastDraftRef.current = draft;
				setByUsRef.current = false;
			}, [draft]);
			(0, react.useEffect)(() => {
				// 【全局📞】按会话记录"已处理的 user 节点"基线:只把"这个会话里真正新增的 user 节点"
				// 当成语音输入去武装朗读,避免把别的会话(或本会话历史)误判成"新语音输入"而串读。
				const prev = lastUserSeqBySession[sessionId] ?? -1;
				for (let i = chatNodes.length - 1; i >= 0; i--) {
					const node = chatNodes[i];
					if (node.kind === "user" && node.seq > prev) {
						lastUserSeqBySession[sessionId] = node.seq;
						userQuestionRef.current = nodeText(node) || "";
						// 【barge-in 修复】仅在"语音类输入"(话筒或📞)时:先停掉当前正在朗读的回复,再接新回复,
						// 否则旧回复语音会继续播(用户说话混着 agent 声)。文字输入不受影响。
						// 【全局📞】再加"归属会话"判断:只有"最近一次语音输入确实发生在本会话"才算语音输入,
						// 否则切到别的会话时,会把那个会话的历史 user 节点当成语音输入去读(串读)。
						const isVoiceInput = ((Date.now() - micUsedAtRef.current < 300 * 1e3) || (Date.now() - sharedVoiceAt < 300 * 1e3)) && voiceInputSessionId === sessionId;
						if (isVoiceInput) {
							// 【切回守卫·根治"打断后切回声停"】打断发生在别的会话时,A 组件不在场、基线没更新,
							// 切回 A 会把"打断后那条 user 节点"当成新输入:原逻辑先 stopReading 再 callArm,
							// 而 callArm 内第一句就是 callStopReading() —— 把引擎【正在念的同一条】又停一刀,
							// 接着因【同 seq 防重】直接 return → 停了没人接管 → 声音中断。
							// 处理:【引擎正要读的这条(node.seq)就是它已经在念的那条(callArmedForSeq)】时,
							// 只更新基线、绝不打断(不管 callArmed 是否刚好为 true——打断后它已被置 false,但 seq 仍在)。
							if (voiceInputIsCall && voiceInputSessionId === sessionId) {
								if (callArmedForSeq === node.seq) {
									// 已在读同一条(seq 一致):仅更新基线,不打断(见上注释)。
								} else {
									try { stopReading(); } catch (e) { console.warn("[dsh-voice] stopReading on new user msg failed", e?.message); }
									callArm(sessionId, node.seq);
								}
							} else {
								// 话筒/文字:保持原"每10秒总结"路径;先释放常驻引擎(避免话筒 turn 被引擎误读/双读)。
								try { stopReading(); } catch (e) { console.warn("[dsh-voice] stopReading on new user msg failed", e?.message); }
								callEngineRelease();
								armReplyReading(node.seq, false);
							}
						}
						break;
					}
				}
			}, [chatNodes, sessionId]);
			(0, react.useEffect)(() => {
				// 【📞常驻引擎单点门控】本会话处于"📞通话模式"(最近一次语音输入是📞且归属本会话)时,朗读由常驻引擎独占,
				// MicButton 不再收尾(防双读/串读)。话筒/文字(voiceInputIsCall=false)时此门控关闭,走原收尾逻辑,不受影响。
				if (voiceInputIsCall && voiceInputSessionId === sessionId) return;
				// 收尾稳定期判定:只有"回复真正完成"才做完整收尾总结(含引导语)。
				// "真正完成"必须同时满足:
				//   running === false(停止生成)
				//   partial === null(无在途流式内容;thinking 时 partial 非空,不会被误判成结束)
				//   runningCalls.length === 0(无正在运行的工具,如 pwsh;任务执行中不会误判成结束)
				//   且以上状态连续稳定 SETTLE_MS(1.5s) 后才收尾;期间任一变化都会取消并重置。
				// 这样 thinking / 长时间跑工具 期间绝不被当成"已结束"而提前说引导语。
				const clearSettle = () => {
					if (settleTimerRef.current !== null) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
				};
				// 【全局📞】朗读只认"武装归属的那个会话"。若当前查看的是别的主会话(比如 A 在通话、正在看 B),
				// 不要用 B 的 partial/chatNodes 去收尾(否则会把 B 的回复当成待读内容),直接丢弃本次收尾。
				if (armedSessionRef.current !== sessionId) return;
				if (!chatArmedRef.current) { clearSettle(); return; }
				// 【完成判定收紧版】"真正完成"= 已停止生成(!running) + 无正在运行的工具(runningCalls 空)
				//   + partial 里没有"思考中"的 reasoning 内容。
				// partial 为 null(=已写完) 或 partial 只含 text 内容(无 reasoning,就是最后那段)都算完成,
				// 这样即使 partial 没有及时清成 null,只要没有 reasoning(不是 thinking),也能正确收尾出引导语;
				// 而 thinking/长思考时 partial 里有 reasoning → 仍会被挡住,不会提前出引导语。
				const partialHasReasoning = (partial && partial.blocks && partial.blocks.some((b) => b.kind === "reasoning")) || false;
				const ready = !running && (runningCalls?.length ?? 0) === 0 && (partial === null || !partialHasReasoning);
				if (!ready) {
					clearSettle(); return;
				}
				// 找到已提交的 assistant 完整回复节点。
				let node = null;
				for (let i = chatNodes.length - 1; i >= 0; i--) {
					const n = chatNodes[i];
					if (n.kind === "assistant" && n.seq > replySeqRef.current) { node = n; break; }
				}
				if (!node) {
					// 【门控复位】已武装(chatArmedRef=true)却没有比 replySeqRef 更新的 assistant 回复可读
					// (如该轮回复被取消/未提交、或上一次武装落在空提交上)。此时没有待读内容,
					// 必须把门控复位为 false,否则残留会导致之后把"最近一条 assistant 回复"误读。
					chatArmedRef.current = false;
					clearSettle();
					return;
				}
				// 已有待定的稳定期定时器 → 不动(继续等稳定,不重复起、不重置窗口)。
				if (settleTimerRef.current !== null) return;
				const gen = settleGenRef.current;
				settleTimerRef.current = setTimeout(() => {
					settleTimerRef.current = null;
					// 已进入新回复(gen 变了)或已取消(armed=false)则丢弃。
					if (gen !== settleGenRef.current || !chatArmedRef.current) return;
					// —— 稳定 1.5s,执行完整收尾总结(含引导语) ——
					replySeqRef.current = node.seq;
					chatArmedRef.current = false;
					const fullText = extractPartialText(node);
					// 【B1】📞:把"攒的余句 + 还没念完的尾句"补齐(避免流式收尾丢内容、碎块),再补收尾语。
					// 只对"本条回复确实由📞发起"(replyIsCallRef=true)走 B1;话筒/文字走下方收尾总结。
					if (replyIsCallRef.current) {
						const tail = fullText.length > b1SpokenRef.current ? fullText.slice(b1SpokenRef.current).trim() : "";
						const run = summaryChainRef.current.then(() => {
							if (b1ChunkRef.current.trim()) { const s = toSpeechText(b1ChunkRef.current); if (s) enqueueReplySegments([s]); }
							b1ChunkRef.current = "";
							if (tail) { const s = toSpeechText(tail); if (s) enqueueReplySegments([s]); }
							enqueueReplySegments([CLOSING_TEXT]);
							return true;
						});
						summaryChainRef.current = run.catch(() => false);
						run.then(() => finalizeReading());
						return;
					}
					const offset = summaryOffsetRef.current;
					const remaining = fullText.length > offset ? fullText.slice(offset) : "";
					if (!remaining.trim()) {
						// 全部内容已被分段总结朗读:没有"剩余后半段"可再总结。但用户要求结尾要有引导句,
						// 所以补一句简短收尾(不重复内容,只结束语+引导句)。仅当正文确实存在时才补;空回复直接收尾。
						// 经 summaryChain 保持与仍在途的分段总结同序(排在它们之后),避免"引导句先念、后面又补一段"乱序。
						if (fullText.trim()) {
							const run = summaryChainRef.current.then(() => { enqueueReplySegments([CLOSING_TEXT]); return true; });
							summaryChainRef.current = run.catch(() => false);
							run.then(() => finalizeReading());
						} else {
							finalizeReading();
						}
						return;
					}
					// 完结点:对剩余后半段做一次"完整收尾总结"(final=true 带引导句),
					// 追加到总结链,排在已入队的分段总结之后,保证朗读顺序正确、播放不中断。
					summarizeToSpeech(remaining, true).then(() => finalizeReading());
				}, SETTLE_MS);
			}, [chatNodes, running, partial, runningCalls]);
			/**
			* Start one recognition segment (continuous false — the reliable mode that
			* actually delivers interim results). On segment end, auto-restart while
			* monitoring stays on, so listening is continuous across silences.
			*/
			const startRecognizer = () => {
				// 【稳定性修复】识别已走本地 whisper(/voice/stt),不用浏览器在线 SpeechRecognition。
				// 浏览器在线识别的 onend 会自动重启(onend→startRecognizer→onend...),在高频失败/连不上时
				// 会死循环卡死主线程 —— 这是"一按就卡死"的根因。这里空实现,彻底去掉死循环。
				return;
			};
			/** Enter monitoring: fresh transcript base, then keep the recognizer running. */
			const beginMonitoring = () => {
				monitoringRef.current = true;
				accRef.current = new TranscriptAccumulator();
				baseRef.current = draft;
				lastDraftRef.current = draft;
				startRecognizer();
				// 同时启动 MediaRecorder 录音:按住说话(松开提交)时用本地 whisper 识别,
				// 不依赖不稳定的浏览器在线识别。若录音启动失败,回退浏览器识别。
				try {
					const mr = createMediaRecorderController();
					mr.start().catch((e) => {
						console.warn("[dsh-voice] MediaRecorder start failed, using browser recognition", e?.message);
						mediaRecorderRef.current = null;
					});
					mediaRecorderRef.current = mr;
				} catch (e) {
					console.warn("[dsh-voice] MediaRecorder unsupported, using browser recognition", e?.message);
					mediaRecorderRef.current = null;
				}
			};
			const stopMonitoring = () => {
				monitoringRef.current = false;
				const rec = recRef.current;
				recRef.current = null;
				rec?.stop();
				// 若是点击(非按住说话)结束监听,也停掉后台录音,避免泄露麦克风
				const mr = mediaRecorderRef.current;
				mediaRecorderRef.current = null;
				if (mr !== null) mr.stop();
			};
			/**
			* Stop the current recognizer and start a fresh one. Suppresses the old
			* recognizer's handlers so its `onend` cannot double-start, and drops any
			* stale transcript the old session might still emit.
			*/
			const restartRecognizer = () => {
				const old = recRef.current;
				if (old !== null) {
					recRef.current = null;
					old.onend = () => {};
					old.onerror = () => {};
					old.stop();
				}
				startRecognizer();
			};
			/** Hold released → submit the transcript as a message (voice chat). */
			const submitChat = async () => {
				monitoringRef.current = false;
				setMicState("idle");
				// 优先用「录音 → /voice/stt(本地whisper)」识别文字;
				// 因为浏览器在线识别不稳定,用本地 whisper 更可靠。失败则回退浏览器识别文字。
				const mr = mediaRecorderRef.current;
				mediaRecorderRef.current = null;
				let text = "";
				if (mr !== null) {
					try {
						mr.stop();
						const { blob } = await mr.finished;
						const audioBytes = await blob.arrayBuffer();
						const resp = await fetch("/voice/stt", {
							method: "POST",
							headers: { "Content-Type": "application/octet-stream" },
							body: audioBytes,
						});
						if (!resp.ok) throw new Error(`STT ${resp.status}`);
						const j = await resp.json();
						text = (j.text || "").trim();
					} catch (e) {
						console.warn("[dsh-voice] whisper STT failed, falling back to browser recognition", e?.message);
					}
				}
				// 回退:浏览器在线识别的累积文字
				if (!text) {
					const rec = recRef.current;
					recRef.current = null;
					rec?.stop();
					text = accRef.current.transcript.trim();
				}
				if (text.length > 0 && /[\u4e00-\u9fa5A-Za-z]/.test(text)) {
					// 【门控修复】只在真正提交文本时才武装回复朗读。原逻辑无条件 armReplyReading(Infinity):
					// 若 STT 识别失败/空文本,什么都没提交,却提前把 chatArmedRef=true,
					// 留下门控残留 → 之后(如切回已有会话)会把最近一条 assistant 回复误读。现移到提交块内。
					// 【📞常驻引擎】话筒 turn：先释放常驻引擎(若通话中在读 A 的📞回复),避免话筒 turn 被引擎误读/双读。
					// (在归属会话 A 通话中又用话筒按住说时,话筒走原"每10秒总结"路径,引擎让位。)
					callEngineRelease();
					armReplyReading(Infinity, false);
					inputActions.setDraft(text);
					// 用 steer 模式:打断 AI 当前正在生成的回复,立刻转向这条新的语音输入。
					// 这是「真打断」——不只是停朗读,而是让 AI 停止当前 turn、响应你的新话。
					// (DSH 的 InputSubmitMode = 'queue' | 'steer';steer 会中断进行中的回答)
					inputActions.submit("steer");
				}
			};
			const onPointerDown = () => {
				if (micState === "unsupported") return;
				// 【跨会话通话状态机】统一判断本会话(以及任何会话)能否用语音入口,按①②③④分支处理。
				const entry = evaluateVoiceEntry(sessionId);
				let readingStopped = false;
				if (entry.situation === "other_call") {
					// 情况①:有全局通话、但归属别的会话 → 话筒不"本地录/提交",因为麦克风已被"通话归属会话 A 的 /voice/stream"
					// 全局采集:在这里说话,识别自动归到 A 并只打断 A(见 voiceInterruptHandler 的全局驱动分支)。
					// 所以这里只做两件事:按下时停一下 A 的朗读(用户要开口了),并吞掉本会话的 pointer-up(绝不提交到 B)。
					if (entry.ownerSessionId != null) {
						try { if (typeof voiceInterruptHandler === "function") voiceInterruptHandler(); } catch {}
						voiceInputSessionId = entry.ownerSessionId;
						voiceInputIsCall = true; // 归属到通话路径(边生成边逐句念)
						sharedVoiceAt = Date.now();
						micUsedAtRef.current = Date.now();
					}
					// 不弹"占用"提示:通话开着时麦克风是全局在听的,用户说话会进 A —— 无需"挂断才能用"。
					stopTapRef.current = true; // 吞掉本次 pointer-up,不触发监听/发送。
					return;
				}
				if (entry.situation === "voice_busy") {
					// 情况③:无通话但别的会话语音还在播/没播完 → 先确认"是否立即结束其它会话播报"。
					const endNow = window.confirm("其他会话的语音播报还未结束，是否立即结束？");
					if (endNow) {
						// 是:立即结束那会话的播报(停其朗读+清其队列)。
						try { if (typeof voiceStopReadingHandler === "function") voiceStopReadingHandler(); } catch {}
						readingStopped = true;
					} else {
						// 否:其它会话继续播;本会话话筒不可用,提示;再次点击会再出提示(可再选)。
						window.alert("请等其他会话语音播报结束后才可使用。");
						stopTapRef.current = true;
						return;
					}
				}
				// (own_call / own_busy / free / voice_busy已确认结束) → 正常录音/打断流程。
				// AI 正在朗读/回答时按麦克风 = 想打断:调用 session-scoped conversation.cancel()
				// 取消 AI 当前生成(文字流式输出也停),再停朗读,并继续进入录音流程。
				if (readingReply && !readingStopped) {
					stopTapRef.current = false;
					try {
						cancel?.();
					} catch (e) {
						console.warn("[dsh-voice] conversation.cancel failed", e?.message);
					}
					stopReading();
				}
				stopTapRef.current = false;
				unlockReplyAudio();
				micUsedAtRef.current = Date.now();
				sharedVoiceAt = Date.now();
				// 【全局📞】记录"这次语音输入属于本会话"(话筒按住说),供 isVoiceInput 判断归属,
				// 避免切到别的会话时把它当成该会话的语音输入去读。
				voiceInputSessionId = sessionId;
				// 【📞B1】话筒按住说 → 这不是📞通话,回复朗读走旧"每10秒总结"路径。
				voiceInputIsCall = false;
				wasListeningRef.current = micState === "listening";
				holdingRef.current = false;
				if (!wasListeningRef.current) {
					beginMonitoring();
					holdTimerRef.current = window.setTimeout(() => {
						holdingRef.current = true;
					}, HOLD_THRESHOLD);
				}
			};
			const onPointerUp = () => {
				if (stopTapRef.current) {
					stopTapRef.current = false;
					return;
				}
				if (holdTimerRef.current !== null) {
					clearTimeout(holdTimerRef.current);
					holdTimerRef.current = null;
				}
				if (holdingRef.current) {
					// 长按说话 → 松开提交(走 submitChat,会停录音并上交文字)。
					holdingRef.current = false;
					submitChat();
				} else if (monitoringRef.current) {
					// ⚠️ 防"无按钮却开麦":快速点按(未到长按阈值)时,/voice/stt 监听路径已停用(startRecognizer 是空实现),
					// 而按住说话的 MediaRecorder 是在 pointerdown 就启的;若不在松手时释放,录音流会一直开着
					// (麦克风常亮/后台持续采音)。这里一旦没进入长按提交,就立即释放麦克风,绝不留麦、不自动识别。
					stopMonitoring();
				}
			};
			const onPointerLeave = () => {
				if (holdingRef.current) {
					holdingRef.current = false;
					submitChat();
				} else if (monitoringRef.current) {
					// 同 onPointerUp:指针移出且未到长按阈值 → 释放麦克风,避免漏麦。
					stopMonitoring();
				}
			};
			const listening = micState === "listening";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-voice-control",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-voice-input",
					onPointerDown,
					onPointerUp,
					onPointerLeave,
					"aria-pressed": listening,
					"aria-label": t("mic.label"),
					"data-reading": readingReply || void 0,
					title: readingReply ? t("mic.title.reading") : listening ? t("mic.title.listening") : t("mic.title"),
					disabled: micState === "unsupported",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, {
						listening,
						readingReply
					})
				})
			});
		}
		/** A linear mic icon; DeepSeek blue while listening/reading, theme primary otherwise. */
		function MicIcon({ listening, readingReply }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dsh-voice-icon",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: `@keyframes dsh-mic-pulse{0%,100%{opacity:1}50%{opacity:.45}}.dsh-voice-input{border:none;background:transparent;padding:4px;cursor:pointer;display:inline-flex;align-items:center;line-height:0;color:inherit;border-radius:6px}.dsh-voice-input:hover{background:var(--dsw-alias-interactive-bg-hover);opacity:1}.dsh-voice-icon{display:inline-flex;width:17px;height:17px;color:${listening || readingReply ? DEEPSEEK_BLUE : "var(--dsw-alias-label-secondary)"}}.dsh-voice-icon svg{width:100%;height:100%}.dsh-voice-input[aria-pressed="true"] .dsh-voice-icon{animation:dsh-mic-pulse 1s ease-in-out infinite}.dsh-voice-input[data-reading] .dsh-voice-icon{animation:dsh-mic-pulse 1s ease-in-out infinite}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
							x1: "12",
							y1: "19",
							x2: "12",
							y2: "23"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
							x1: "8",
							y1: "23",
							x2: "16",
							y2: "23"
						})
					]
				})]
			});
		}
		//#endregion
		/** 【📞自动接话】独立通话按钮:持续采 mic → 推 /voice/stream → 收到 {type:'turn',text} → setDraft+submit 进 agent。
		* 与话筒(按住说)分开,互不影响;on 时也更新 sharedVoiceAt 让回复朗读触发。 */
		/** 【📞自适应推理】多维规则判"这轮要不要深思考":极短/闲聊→off(不思考,最快);任务/分析类词→high(深思);较长但非明确任务→low。 */
		function judgeEffort(text) {
			const t = String(text || "").trim();
			if (!t) return "off";
			const taskRe = /(分析|规划|计算|写|代码|为什么|方案|对比|论证|解释|如何|怎么|比较|总结|评估|设计|实现|研究|推理|证明|部署|优化|测试|修复|报错|命令|脚本|依赖|配置|架构|流程|文档|电路|函数|算法|数据库|调试|排查)/;
			if (t.length <= 12) return "off";
			if (taskRe.test(t)) return "high";
			if (t.length > 40) return "low";
			return "off";
		}
		/** 📞电话图标:默认绿色=未通话;通话中红色=已开(本会话是通话发起方);灰色=被其它会话占用/不可用。 */
		function PhoneIcon({ active, occupied }) {
			const color = occupied ? "#999999" : (active ? "#e74c3c" : "#2ecc71");
			return (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-voice-icon",
				style: { color },
				children: (0, react_jsx_runtime.jsx)("svg", {
					viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
					children: (0, react_jsx_runtime.jsx)("path", { d: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" })
				})
			});
		}
		function TelButton({ useSession, useChat, inputActions, t, sessionId, sessions }) {
			const [callOn, setCallOn] = (0, react.useState)(false);
			const [modeLabel, setModeLabel] = (0, react.useState)("");
			// 【DSH 0.1.2 兼容·引擎数据源】新版 useSession 返回 SessionSnapshot(无 chat.legacy.nodes),
			// 聊天节点列表(带 kind/seq)在新版由 useChat 提供(s.legacy.nodes)。这里监听它,检测"新用户消息"→驱动常驻引擎朗读。
			// 引擎(callOnSnapshot 等)仍走 session.getSnapshot()(模块级非常驻),但新版那条已断 —— 所以在组件层补一个
			// useChat 监听,把"新消息"交给引擎 callArm(跟 callOnSnapshot 等价,且走新版官方数据通道)。
			const chatNodes = (useChat && typeof useChat === "function")
				? useChat((state) => state?.legacy?.nodes ?? [])
				: (useSession ? useSession((state) => state?.chat?.legacy?.nodes ?? []) : []);
			// 【DSH 0.1.2 兼容】useChat 拿到聊天节点/流式文字/运行工具 → 同步写入模块级缓存,供非 React 常驻引擎读取。
			// 新版 session.getSnapshot() 已无 nodes/partial/runningCalls(全在 useChat 的 legacy),不缓存引擎就读不到。
			try { callChatNodesCache = chatNodes; } catch {}
			if (useChat && typeof useChat === "function") {
				try {
					callPartialCache = useChat((state) => state?.legacy?.partial ?? null) ?? null;
					callRunningCallsCache = useChat((state) => state?.legacy?.runningCalls ?? []) ?? [];
				} catch {}
			}
			const lastUserSeqRef = (0, react.useRef)(-1);
			(0, react.useEffect)(() => {
				// 只在📞通话中生效(getUserMedia 提交的 turn → callArm)。非通话时不为无害。
				if (!callActive || !callOwnerId) return;
				if (voiceInputSessionId !== callOwnerId) return;
				let maxUser = -1;
				for (const n of chatNodes) if (n && n.kind === "user" && typeof n.seq === "number" && n.seq > maxUser) maxUser = n.seq;
				if (maxUser < 0) return;
				// 只处理"比引擎已处理基线更新的"新 user 消息(防历史/重复)。
				if (maxUser > lastUserSeqRef.current) {
					lastUserSeqRef.current = maxUser;
					// 与 callArm 内的"同 seq 防重"一致: 只有真正的新输入才武装。
					if (callArmedForSeq !== maxUser) {
						try { callArm(callOwnerId, maxUser); } catch (e) { console.warn("[dsh-voice] tel useChat arm failed", e?.message); }
					}
				}
			}, [chatNodes]);
			// 【图标必刷新】isOwner/occupied 依赖模块级 voiceCallActive。原来用 forceRender(空 tick)手动强制刷新,
			// 但它在 React 里偶尔会被丢弃(长通话刷新频繁时) → 图标卡在旧颜色。改用 useSyncExternalStore:
			// 订阅"通话状态外部源",状态一变必定重渲染,绝不被丢弃。isOwner/occupied 直接用快照重算。
			const callStateSnap = (0, react.useSyncExternalStore)(subscribeCallState, getCallStateSnapshot);
			const [, forceRender] = (0, react.useState)(0);
			const stopRef = (0, react.useRef)(null);
			// 【全局静音图标跨会话同步】监听全局静音事件刷新按钮图标(其它会话窗口也能看到最新状态)。
			(0, react.useEffect)(() => {
				const onMute = () => forceRender((n) => n + 1);
				try { window.addEventListener("voice-global-mute", onMute); } catch {}
				return () => { try { window.removeEventListener("voice-global-mute", onMute); } catch {} };
			}, []);
			/** 点📞进入会议时保存的"当前模型选择",退出时恢复(隔离:不残留到文字/麦克风)。
			* 【修复3】已挪到模块级单点 callSavedModelRef(与 globalCallSessionId 同生命周期)。
			* 原组件级 useRef 在 A↔B 来回切时被重挂重置为 null,回 A 挂断 restoreModel 读到 null 什么都不做,档位回不去。 */
			/** 按文本判断并临时设本会话的 reasoningEffort(只改推理档位,不改 provider/model)。 */
			const applyEffort = async (text) => {
				const effort = judgeEffort(text);
				// 先更新徽标(不依赖模型保存是否成功):这样用户一定能看到"快答/深思"
				setModeLabel(effort === "high" ? "深思" : "快答");
				const saved = callSavedModelRef;
				if (!saved || !sessions || typeof sessions.selectModel !== "function") return;
				const payload = { sessionId, provider: saved.provider, model: saved.model };
				if (effort) payload.reasoningEffort = effort;
				await sessions.selectModel(payload);
			};
			/** 退出会议:恢复点击前的模型选择(只改回推理档位)。 */
			const restoreModel = async () => {
				const saved = callSavedModelRef;
				if (saved && sessions && typeof sessions.selectModel === "function") {
					const payload = { sessionId, provider: saved.provider, model: saved.model };
					if (saved.reasoningEffort) payload.reasoningEffort = saved.reasoningEffort;
					try { await sessions.selectModel(payload); } catch (e) { console.warn("[dsh-voice] tel restore model failed", e?.message); }
				}
				callSavedModelRef = null;
			};
			// 【📞断流/挂断共用释放】真正释放本通话的物理音频资源:关 WS、断开 proc、停掉所有轨道、关闭 ctx。
			// 幂等:取走后即清空,重复调用不会再释放。同时释放【模块级 callAudioRef】与【组件级 stopRef】两处,
			// 只要任一位置有流就停掉,保证无论组件是否重建,"挂断必停麦克风"。
			const teardownAudio = () => {
				const a = callAudioRef;
				const b = stopRef.current;
				callAudioRef = null;
				stopRef.current = null;
				const release = (s) => {
					if (!s) return;
					try { s.ws && s.ws.close(); } catch {}
					try { s.proc && s.proc.disconnect(); } catch {}
					try { s.stream && s.stream.getTracks().forEach((tt) => tt.stop()); } catch {}
					try { s.ctx && s.ctx.close(); } catch {}
				};
				release(a);
				if (b !== a) release(b);
			};
			const start = async () => {
				let stream, ws, ctx, src, proc;
				// 【修复①·并发守卫】已有 start() 在途(含 getUserMedia 挂起)则直接 return,挡掉连点/双击导致的二次 start。
				// 否则第二次 start 会在 getUserMedia 挂起期间再开一条流并覆盖 callAudioRef/stopRef.current,第一条被架空成孤儿流,
				// 其 ws 的 onclose 又会被身份守卫吞掉 → 幽灵麦克风永久采集。既有修复1a(stopRef.current 判断)只在 getUserMedia
				// 完成后才有效,挡不住挂起窗口,故补此"启动中"标志(根治点之一)。
				if (callStarting) return;
				callStarting = true;
				// 【修复1a·同会话并发护栏】本会话通话已开着(voiceCallActive=true 且归属本会话)且已有一条实际 WS 在跑
				// (stopRef.current 非空)时,即使又触发一次 start()(如在途 getUserMedia 期间再点📞)也直接 return,
				// 避免重复 start() 造成双路 WS/幽灵麦克风 + callEngineStart 重复订阅。正常"点红挂断"走 stop(),不会走到这。
				if (voiceCallActive && globalCallSessionId === sessionId && stopRef.current) return;
				// 【📞全局单点】已有别的会话在通话 → 本会话不可再开(按钮已禁用,这里兜底拦截)。
				if (voiceCallActive && globalCallSessionId !== sessionId) return;
				// 【流式TTS】点在手势内解锁回复音频上下文,让📞回复能走 WebAudio 流式播放(而非 <audio> 兜底)。
				unlockReplyAudio();
				try {
					stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				} catch (e) { console.warn("[dsh-voice] tel getUserMedia failed", e?.message); callStarting = false; return; }
				// 【📞全局单点】麦克风成功后才"真正"进入通话,记录"本次通话归属的会话" = 发起通话的会话(A)。
				// 切换会话【不改动它】,所以 A 的通话不会被切走掐断;只有真正挂断才清。
				globalCallSessionId = sessionId;
				voiceCallActive = true;
				notifyCallStateChange(); // 图标随状态刷新(开📞→红色)
				// 【📞常驻引擎】开📞即订阅"通话归属会话 A"的 snapshot(跨会话常驻,切会话不丢,读 A 的📞回复)。
				callEngineStart(sessionId);
				// 进入会议:保存当前模型选择(供退出恢复,隔离不影响文字/麦克风)
				if (sessions && typeof sessions.models === "function") {
					try {
						const { result } = await sessions.models({ sessionId });
						if (result && result.value && result.value.current) callSavedModelRef = { ...result.value.current };
					} catch (e) { console.warn("[dsh-voice] tel read current model failed", e?.message); }
				}
				ws = new WebSocket("ws://127.0.0.1:9881/voice/stream");
				ws.binaryType = "arraybuffer";
				ws.onmessage = async (e) => {
					let j = null; try { j = JSON.parse(e.data); } catch { return; }
					if (j && j.type === "speech_start") {
						// 【重开保护期】重开📞麦刚建立的 1.2s 内,忽略 speech_start(防把环境/过渡声误当"你开口"→停掉上一段)。
						if (Date.now() < callSpeechIgnoreUntil) {
							logReadingStop("ws: speech_start(保护期忽略)");
							return;
						}
						// 【barge-in·"声音立即断、文字延迟判停"】你开口→【只立即停朗读声音】,【不立即取消生成】。
						// 留出时间识别你是"总结一下"还是"其它话":
						//   - "总结" → 文字继续生成,调总结;
						//   - "其它话" → 由下方提交(steer)真正打断生成。
						// (这样"总结"不会因为开口就被当作普通打断而停掉文字。)
						logReadingStop("ws: speech_start");
						if (typeof callStopReadingSoundOnly === "function") { try { callStopReadingSoundOnly(); } catch {} }
						return;
					}
					if (j && j.type === "turn" && j.text) {
						const now = Date.now();
						const turnText = String(j.text || "").trim();
						// 【全局驱动·路由归属(B 要求)】路由只按"全局通话状态"判:只要 voiceCallActive && globalCallSessionId==本会话(A),
						// 就把 turn 识别结果归到"通话归属会话(A)"(本闭包的 sessionId/inputActions 就是开📞时绑定的 A),【不再看当前查看哪个会话】。
						// 所以用户哪怕切到别的会话/正在做文字任务,只要开口说话,识别也归到 A 并只打断 A —— 而不是被 currentViewSessionId 挡下、
						// 或误提交到"当前任务会话"。仅在两处仍丢弃:①通话已挂断/归属已清(残留在途 turn);②识别文本纯噪声(下面真字符判断)。
						// (注:闭环的环境音/回声自动提交仍由"真字符过滤 + 同句去重"兜底,见下。)
						if (!voiceCallActive || globalCallSessionId !== sessionId) {
							return;
						}
						// 【防假识别自动提交】whisper 在静音/纯噪声上会幻觉出乱码。只提交含真实中/英文字符的文本:
						// 形如 "。""？！""，," 这类纯标点/符号的噪声文本一律丢弃,避免把垃圾识别自动提交。
						if (!/[\u4e00-\u9fa5A-Za-z]/.test(turnText)) {
							return;
						}
						// 【防重复】同一句很短时间内再次出现(如 VAD 双发、自家语音回环) → 忽略,不重复提交。
						// 判同句:①时间窗放宽到 3 秒(原 1.6 秒会漏"间隔稍长"的同句);②比较用"去标点空白后的核心文本"。
						// 这样"你好"与"你好。""你好 "即便被识别成两条 turn,也会被合并成一次提交,避免引擎重复武装→叠音。
						const normTurn = normTurnText(turnText);
						if (turnText && now - lastTurnAt < 3000 && normTurn && normTurn === normTurnText(lastTurnText)) {
							return;
						}
						if (turnText) { lastTurnAt = now; lastTurnText = turnText; }
						// 【📞边聊边总结】用户说"总结一下/总结"→ 取最近对话调 /voice/summarize 转成口语,用用户音色念出;不当作普通问题提交 agent。
						if (isSummaryRequest(turnText)) {
							try {
								// 【总结·只取当前这轮】不再取最近8条(会把上面的历史卷进来,挤占字数、总结不到位)。
								// 改为只取"最近一次提问→agent回复"这段。
								const recent = getCurrentTurnConversation(globalCallSessionId);
								if (recent) {
									// 【总结·只停声音不作废生成】"总结一下"只停当前朗读声,文字继续生成(你之前确认的)。
									// 不能用 callStopReading(它 callGen+1 作废在途生成 → 连文字也停)。用只停声音的轻量动作。
									try { if (typeof callStopReadingSoundOnly === "function") callStopReadingSoundOnly(); } catch {}
									const r = await fetch("/voice/summarize", {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({ text: recent, sessionId: globalCallSessionId }),
									});
									if (r.ok) {
										const j = await r.json();
										const summary = ((j && j.text) || "").trim();
										// 【修正·总结不漏尾】总结很长时整段 TTS 合成易不稳定→后半段丢失。
										// 按 ≤SUMMARIZE_CHUNK_MAX 拆成多段逐段念,保证长总结完整读完、不漏后半段。
										if (summary) {
											const segs = splitTextByBoundary(summary, SUMMARIZE_CHUNK_MAX);
											for (const s of segs) {
												const seg = (s || "").trim();
												if (seg) callEnqueue([seg]);
											}
										}
									}
								}
							} catch (e) { console.warn("[dsh-voice] summarize-on-demand failed", e?.message); }
							// 只处理"总结",不往下提交 turn(避免把"总结一下"当普通问题丢给 agent)。
							return;
						}
						sharedVoiceAt = Date.now();
						// 【全球📞单点】语音输入归属 = 发起通话的那个会话(A);该会话的回复朗读走 B1 边生成边逐句念。
						// 切到别的会话时,这里的归属仍是 A(模块级变量,跟着通话走),不读其它会话。
						voiceInputSessionId = globalCallSessionId;
						voiceInputIsCall = true; // 这是📞通话 → 该回复朗读走 B1 边生成边逐句念
						// 【自适应推理】按这轮内容判断要不要深思考,并临时调本会话模型选择(📞期间;退出恢复)
						try { await applyEffort(turnText); } catch (e) { console.warn("[dsh-voice] tel applyEffort failed", e?.message); }
						// 【B1】📞:用"边生成边逐句念"指南,让 agent 写可直接朗读的口语正文(不再要求 <speak> 标签)
						const draft = B1_GUIDE + "\n\n" + turnText;
						if (typeof inputActions?.setDraft === "function") inputActions.setDraft(draft);
						if (typeof inputActions?.submit === "function") inputActions.submit("steer");
					}
				};
				// 【防幽灵通话】WS 被异常断开/出错时,若本 WS 仍是通话所有者,就清掉全局通话标志。
				// 否则 voiceCallActive / globalCallSessionId 会卡在"在通话"→ 其它会话电话按钮被误判为占用禁用、
				// 本会话麦克风被误判不可用,残留的"通话仍开"还会让在途 turn 继续自动提交。WS 断开即视为通话停止。
				ws.onclose = () => {
					// 【修复1b·WS 身份守卫】只有"当前这条 WS(stopRef.current.ws===ws)"才清理;迟到的旧 WS
					// (开-挂-再开时,旧 WS 的 close 晚到)直接 return,不清新重建的通话引擎/全局标志。
					// stop() 主动挂断时 teardownAudio 已把 stopRef.current 置 null,这里守卫提前 return,
					// 且 stop() 已自清理(释放麦+退订+清标志),不重复、不误清。
					// 【不影响已验证功能】"断流释放麦克风/防幽灵麦克风"仍保留:当前 WS 时守卫放行,teardownAudio 照常释放。
					if (stopRef.current?.ws !== ws) {
						// 【修复②·幽灵麦兜底】这条迟到的旧 WS 不是当前通话流,但它的 stream 可能仍被单独采集(已被架空成孤儿)。
						// 若它已不在当前 callAudioRef(即非当前通话流),立即停掉它,绝不让"图标已绿/通话已停,麦克风还在录"。
						// 只停这条孤儿流:不调 teardownAudio / 不清全局标志 / 不退订 —— 绝不触碰当前通话状态(跨会话常驻不受影响)。
						if (callAudioRef?.stream !== stream) {
							try { stream && stream.getTracks().forEach((tt) => tt.stop()); } catch {}
						}
						return;
					}
					// 【断流必释放麦克风】WS 断开立即释放本通话的物理采集流,无论是否仍是通话所有者。
					// 否则状态已清"无通话"但 getUserMedia 流仍在采音 → "没点按钮浏览器麦克风却在录"(幽灵麦克风)。
					teardownAudio();
					// 【📞常驻引擎】断流即退订引擎(不再读新内容);已入队/在播的📞语音【不停】,念完或被打断才停。
					callEngineStop();
					if (voiceCallActive && globalCallSessionId === sessionId) {
						voiceCallActive = false;
						globalCallSessionId = null;
						voiceInputIsCall = false;
						voiceInputSessionId = null;
						setCallOn(false);
						notifyCallStateChange(); // 图标随状态刷新(断流→变绿)
					}
					// 【用户强调·自动挂断也要改回模型】断流/自动挂断时就要把"进入通话前保存的模型档位"恢复回去
					// (改回原来的快答/深思),不然模型会停在通话中(auto off)改不回来。用 restoreModel() 读 callSavedModelRef 并改回。
					restoreModel();
				};
				ws.onerror = () => {
					// 【修复1b·WS 身份守卫】同 onclose:只有当前这条 WS 才清理,迟到的旧 WS/已挂断的 WS 直接 return。
					if (stopRef.current?.ws !== ws) {
						// 【修复②·幽灵麦兜底】同 onclose:迟到旧 WS 的流若已是孤儿(不在当前 callAudioRef),立即停掉它,
						// 只停这条流、不调 teardownAudio / 不清标志 / 不退订,绝不触碰当前通话状态。
						if (callAudioRef?.stream !== stream) {
							try { stream && stream.getTracks().forEach((tt) => tt.stop()); } catch {}
						}
						return;
					}
					teardownAudio();
					callEngineStop();
					if (voiceCallActive && globalCallSessionId === sessionId) {
						voiceCallActive = false;
						globalCallSessionId = null;
						voiceInputIsCall = false;
						voiceInputSessionId = null;
						setCallOn(false);
						notifyCallStateChange(); // 图标随状态刷新(断流→变绿)
					}
					// 【用户强调·自动挂断也要改回模型】断流/出错同样恢复模型档位(改回原来的快答/深思)。
					restoreModel();
				};
				try { ctx = new AudioContext({ sampleRate: 16000 }); } catch (e) { ctx = new AudioContext(); }
				try { await ctx.resume(); } catch {}
				src = ctx.createMediaStreamSource(stream);
				proc = ctx.createScriptProcessor(4096, 1, 1);
				proc.onaudioprocess = (e) => {
					if (!ws || ws.readyState !== 1) return;
					const c = e.inputBuffer.getChannelData(0);
					const i16 = new Int16Array(c.length);
					for (let i = 0; i < c.length; i++) i16[i] = Math.max(-1, Math.min(1, c[i])) * 32767;
					ws.send(i16.buffer);
				};
				src.connect(proc); proc.connect(ctx.destination);
				stopRef.current = { ws, stream, ctx, src, proc };
				// 【📞全局兜底】同时存到模块级,保证组件重建后挂断也能释放这条麦克风流。
				callAudioRef = stopRef.current;
				// 【📞重开保护期】麦刚建立,设置"忽略 speech_start"直到(保护1.2秒),防重开瞬间的假 speech_start 误停上一段。
				callSpeechIgnoreUntil = Date.now() + 1200;
				setCallOn(true);
				callStarting = false; // 成功收尾:复位启动中标志(getUserMedia 失败已在 catch 复位,不会卡死后续 start)
			};
			const stop = () => {
				teardownAudio();
				// 【📞常驻引擎】挂断即退订(不再读新内容);已入队/在播的📞语音【不停】,念完或被打断才停(与下面"不再调用 voiceStopReadingHandler"一致)。
				callEngineStop();
				setModeLabel("");
				try { restoreModel(); } catch {}
				// 【📞全局单点】真正"挂断"才清掉全局通话标志(切会话不清;只有挂断才让别的会话可开新电话)。
				voiceCallActive = false;
				globalCallSessionId = null;
				voiceInputIsCall = false;
				voiceInputSessionId = null;
				setCallOn(false);
				notifyCallStateChange(); // 图标随状态刷新(挂断→变绿)
				forceRender((n) => n + 1); // 强制重渲染,让 isOwner/occupied 用最新 voiceCallActive 立即变绿
				// 【📞挂断【不打断当前朗读】】挂断电话只结束"通话/麦克风"(上面的 teardownAudio + 清全局通话标志)。
				// 【不再调用 voiceStopReadingHandler】:挂断≠打断。正在朗读的这条回复要**继续播到"播完"或"你打断(说话)"**才停,
				// 否则"一挂电话语音就断在中途"不符合"语音只在被打断/播完才停"的预期。将来电断开只挡"下一次自动接话",不清当前在念的这条。
				// (若你在播到一半想让它停,用话筒按键打断,或让它自然念完。)
			};
			// 【📞全局单点】按"当前会话"与"通话归属会话"的关系判定按钮状态:
			//   空闲(绿) / 本会话是通话方(红,可挂断) / 别的会话正在通话 → 本会话占用(灰,不可点)。
			const isOwner = voiceCallActive && globalCallSessionId === sessionId;
			const occupied = voiceCallActive && globalCallSessionId !== sessionId;
			const onClick = () => {
				console.info("[dsh-bug][tel] click called; isOwner=" + (voiceCallActive && globalCallSessionId === sessionId) + " callActive=" + voiceCallActive + " owner=" + globalCallSessionId + " s=" + sessionId);
				// 【稳健挂断】红色=本会话是通话方 → 点📞必定执行挂断(直接看全局状态,不依赖状态机判断,
				// 避免朗读进行中/状态竞态时 evaluateVoiceEntry 误返回非 own_call 而"点不动")。
				if (isOwner) { stop(); return; }
				// 【跨会话通话状态机】统一判断本会话能否开电话,按①②③④分支处理。
				const entry = evaluateVoiceEntry(sessionId);
				if (entry.situation === "own_call") { stop(); return; }
				if (entry.situation === "other_call") {
					// 情况①:有通话但归属别的会话 → 提示占线;本会话不可新开电话。
					window.alert("有其他会话正在使用电话会议，请挂断后再来。");
					return;
				}
				if (entry.situation === "voice_busy") {
					// 情况③:无通话但别的会话语音还在播 → 先确认"是否立即结束其它会话播报"。
					if (window.confirm("其他会话的语音播报还未结束，是否立即结束？")) {
						// 是:立即结束那会话的播报(停其朗读+清其队列),本会话可正常开电话。
						try { if (typeof voiceStopReadingHandler === "function") voiceStopReadingHandler(); } catch {}
						start();
					} else {
						// 否:其它会话继续播;本会话电话不可用,提示;再次点击会再出提示(可再选)。
						window.alert("请等其他会话语音播报结束后才可使用。");
					}
					return;
				}
				// 情况④(无通话、无播报)或 own_busy(当前会话自己在播,情况②式) → 本会话可正常开电话。
				start();
			};
			const title = occupied
				? (t ? "通话被其它会话占用（先挂断才能在本会话开新电话）" : "通话被占用")
				: (isOwner
					? (modeLabel ? "挂断（当前:" + modeLabel + "）" : "挂断（结束自动接话）")
					: "通话（你说它自动接，念回复）");
			return (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-voice-control",
				children: [
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-voice-input",
						onClick: onClick,
						disabled: false,
						title,
						"aria-label": t ? t("mic.label") : "语音通话",
						children: (0, react_jsx_runtime.jsx)(PhoneIcon, { active: isOwner, occupied })
					}),
					(isOwner && modeLabel) ? (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-voice-mode",
						style: { marginLeft: "4px", fontSize: "11px", lineHeight: "1", color: modeLabel === "深思" ? "#e67e22" : "#888", whiteSpace: "nowrap" },
						children: modeLabel
					}) : null,
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => {
							callSetMuted(!globalMuted);
							forceRender((n) => n + 1);
						},
						title: globalMuted ? "取消静音（恢复朗读）" : "静音（通话/话筒朗读都只出文字，不出声）",
						style: { marginLeft: "4px", fontSize: "12px", lineHeight: "1", border: "none", background: "transparent", color: globalMuted ? "#e67e22" : "#8a8a8a", cursor: "pointer", padding: "2px 4px" },
						children: globalMuted ? "🔇" : "🔊"
					})
				]
			});
		}
		/**
		* 【设置页骨架】四个标签（音色/设备/模型/API）的占位表单壳：
		* 用 scope.getSnapshot() 显示当前值、scope.set(field, value) 写入字段、[保存] 提交。
		* 本步不做实际功能，仅验证"设置页能显示 + 值能写到 settings.yaml"。
		* @param scope - section inject 返回的绑定 scope（settingsScope.bind({namespace:"voice-input"})）。
		* @param t - locale 绑定函数。
		*/
		function VoiceSettingsPage({ scope, t }) {
			const tf = t || ((key) => key);
			const [tab, setTab] = (0, react.useState)("voice");
			const [draft, setDraft] = (0, react.useState)({});
			const [saved, setSaved] = (0, react.useState)(false);
			const [showKey, setShowKey] = (0, react.useState)(false);
			const [, forceRender] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (scope === void 0 || typeof scope.subscribe !== "function") return void 0;
				return scope.subscribe(() => forceRender((n) => n + 1));
			}, [scope]);
			// 【真实设备/模型检测】在宿主端读取（浏览器拿不到 nvidia-smi/模型目录），此处仅 fetch 只读接口。
			// gpus/cpuName：真实显卡名列表与 CPU 型号（供设备下拉显示本机真实配置）。
			const [devState, setDevState] = (0, react.useState)({ status: "loading", devices: null, gpus: [], cpuName: "", error: null });
			const [modelState, setModelState] = (0, react.useState)({ status: "loading", models: null, error: null });
			(0, react.useEffect)(() => {
				let alive = true;
				fetch("/voice/devices")
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((j) => { if (alive) setDevState({ status: "ok", devices: (j && Array.isArray(j.devices)) ? j.devices : null, gpus: (j && Array.isArray(j.gpus)) ? j.gpus : [], cpuName: (j && j.cpuName) || "", error: (j && j.error) || null }); })
					.catch((e) => { if (alive) setDevState({ status: "error", devices: null, gpus: [], cpuName: "", error: String((e && e.message) || e) }); });
				fetch("/voice/models")
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((j) => { if (alive) setModelState({ status: "ok", models: (j && Array.isArray(j.models)) ? j.models : null, error: (j && j.error) || null }); })
					.catch((e) => { if (alive) setModelState({ status: "error", models: null, error: String((e && e.message) || e) }); });
				return () => { alive = false; };
			}, []);
			// 【音色管理】上传→裁剪≤5s→识别→确认→入库（本标签真功能状态）。
			const [voiceBusy, setVoiceBusy] = (0, react.useState)(false);
			const [voicePending, setVoicePending] = (0, react.useState)(null);
			const [voiceErr, setVoiceErr] = (0, react.useState)("");
			// 【音色预热】切换音色时后台提前把该音色参考特征算好(首句更快);preparing=正在准备的音色 id。
			const [voicePreparing, setVoicePreparing] = (0, react.useState)("");
			// 【模型开关】本地引擎启停（9881 STT / 9882 TTS）；状态来自 /voice/models/status（端口探测）。
			// pending = {id, action}：点击后立即显示"启动中…/停止中…"，完成后再变"已启动/已停止"。
			// 【engineMode 在下方 valueAt 定义后才定义(见下)——必须先有 valueAt,否则设置页渲染抛 TDZ 错误变成空白】。
			const [engState, setEngState] = (0, react.useState)({ status: "loading", engines: null, err: "", pending: null });
			const loadEngines = () => {
				fetch("/voice/models/status" + (engineMode === "api" ? "?mode=api" : ""))
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((j) => {
						if (j && j.ok && j.engines) setEngState((p) => ({ status: "ok", engines: j.engines, err: "", pending: null }));
						else setEngState((p) => ({ status: "error", engines: null, err: (j && j.error) || "状态读取失败", pending: p.pending }));
					})
					.catch((e) => setEngState((p) => ({ status: "error", engines: null, err: String((e && e.message) || e), pending: p.pending })));
			};
			const toggleEngine = async (id) => {
				if (engState.pending && engState.pending.id) return; // 一次只处理一个，防连点
				const cur = engState.engines && engState.engines[id];
				const action = cur && cur.running ? "stop" : "start";
				// 【API 模式·同一家联动】STT/TTS 填的 key 相同(且非空) = 同一家 → 一个启动全启动/一个禁用全禁用。
				// 本地模式不联动(各自独立,保持你验证过的启停完美逻辑)。
				const sameVendor = (engineMode === "api"
					&& String(valueAt("sttApiKey") || "").trim().length > 0
					&& String(valueAt("sttApiKey") || "").trim() === String(valueAt("ttsApiKey") || "").trim());
				const ids = sameVendor ? ["stt", "tts"] : [id];
				// 【即时反馈】点击立即显示"启动中…/停止中…"（不等后台完成）。
				setEngState((p) => ({ ...p, status: "ok", pending: { id: sameVendor ? "stt+tts" : id, action }, err: "" }));
				try {
					// 联动时先按顺序逐个处理,任一失败即停(避免一部分成功一部分失败状态混乱)
					for (const eid of ids) {
						const r = await fetch("/voice/models/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: eid, action, mode: engineMode }) });
						const j = await r.json().catch(() => ({}));
						if (!r.ok || !j.ok) {
							setEngState((p) => ({ status: "error", engines: p.engines, err: (j && j.error) || "操作失败", pending: null }));
							return;
						}
					}
					loadEngines(); // 完成后刷新状态 → 显示"已启动/已停止/已连接/已断开"
				} catch (e) {
					setEngState((p) => ({ status: "error", engines: p.engines, err: String((e && e.message) || e), pending: null }));
				}
			};
			(0, react.useEffect)(() => { loadEngines(); }, []);
			const [voiceName, setVoiceName] = (0, react.useState)("");
			const [voiceText, setVoiceText] = (0, react.useState)("");
			const fileRef = (0, react.useRef)(null);
			if (scope === void 0) return null;
			const snap = scope.getSnapshot();
			if (snap === void 0 || snap.status === "unavailable") {
				return (0, react_jsx_runtime.jsx)("div", { children: tf("settings.unavailable") });
			}
			const value = (snap.value && typeof snap.value === "object") ? snap.value : {};
			const valueAt = (key) => (draft[key] === void 0 ? (value[key] ?? "") : draft[key]);
			// 【engineMode 定义在 valueAt 之后(必须有 valueAt 才能读)】供 loadEngines/toggleEngine/engineRow 用。
			const engineMode = String(valueAt("engineMode")) === "api" ? "api" : "local";
			const setField = (key, val) => { setDraft((prev) => ({ ...prev, [key]: val })); setSaved(false); };
			const save = () => {
				for (const key of Object.keys(draft)) {
					try { scope.set(key, draft[key]); } catch {}
				}
				setSaved(true);
			};
			const inputStyle = { width: "100%", padding: "6px", borderRadius: 6, border: "1px solid #ccc", background: "transparent", color: "inherit", boxSizing: "border-box" };
			const labelStyle = { display: "block", fontSize: 12, marginBottom: 4, color: "#888" };
			const fieldWrap = { display: "block", marginBottom: 12 };
			const hintStyle = { fontSize: 12, color: "#888", lineHeight: "1.5", marginBottom: 12 };
			// ---- 音色标签（真功能）：已训练列表 + 上传/训练/确认/入库。只在"音色"标签渲染，不影响其它标签/已验证功能。 ----
			const btnStyle = { whiteSpace: "nowrap", padding: "4px 10px", borderRadius: 6, border: "1px solid #ccc", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 };
			const btnPrimary = { whiteSpace: "nowrap", padding: "6px 16px", borderRadius: 6, border: "none", background: "#4d6bfe", color: "#fff", cursor: "pointer", fontSize: 13 };
			// 【模型开关】引擎行：名称 + 状态（已启动/已停止/已连接/已断开）+ 启停按钮。
			// 本地模式 = 启停本地服务进程；API 模式 = 连/断对应云端 API(key 相同=同一家,联动)。
			const engineRow = (id, label) => {
				const e = engState.engines && engState.engines[id];
				const running = !!(e && e.running);
				const pend = (engState.pending && engState.pending.id) === id ? engState.pending : null;
				const stateText = pend ? (pend.action === "start" ? "启动中…" : "停止中…") : (running ? (engineMode === "api" ? "已连接" : "已启动") : (engineMode === "api" ? "已断开" : "已停止"));
				const stateColor = pend ? "#e67e22" : (running ? "#2e7d32" : "#999");
				return (0, react_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }, children: [
					(0, react_jsx_runtime.jsx)("span", { style: { flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: label }),
					(0, react_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: stateColor, whiteSpace: "nowrap" }, children: stateText }),
					(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: () => toggleEngine(id), disabled: engState.status === "loading" || !!engState.pending, style: btnStyle, children: pend ? (pend.action === "start" ? "启动中…" : "停止中…") : (engineMode === "api" ? (running ? "断开" : "连接") : (running ? "停止" : "启动")) })
				] });
			};
			const voiceList = Array.isArray(value.voices) ? value.voices : [];
			const voiceSelectedId = String(value.selectedVoiceId || "");
			// 前端用 Audio 元数据校验时长 ≤30s（读取失败不阻断，交给后端按大小兜底）。
			const checkDur = (file) => new Promise((resolve) => {
				try {
					const vurl = URL.createObjectURL(file);
					const a = new Audio();
					a.preload = "metadata";
					a.onloadedmetadata = () => { const d = a.duration; URL.revokeObjectURL(vurl); resolve(Number.isFinite(d) ? d : -1); };
					a.onerror = () => { URL.revokeObjectURL(vurl); resolve(-1); };
					a.src = vurl;
				} catch { resolve(-1); }
			});
			const handleSelect = (id) => {
				try { scope.set("selectedVoiceId", id); } catch { /* ignore */ }
				// 【音色预热】选中即后台提前提取该音色参考特征,并把"正在准备/已就绪"显示给用户。
				setVoicePreparing(id);
				// 失败不阻断选择(只是首句慢一点),清除准备中状态即可。
				fetch("/voice/voices/prewarm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
					.then((r) => r.json().catch(() => ({ ok: false })))
					.then(() => setVoicePreparing(""))
					.catch(() => setVoicePreparing(""));
			};
			const handleDelete = async (id) => {
				setVoiceErr("");
				if (typeof window !== "undefined" && window.confirm && !window.confirm(tf("settings.voice.deleteConfirm"))) return;
				try {
					const r = await fetch("/voice/voices/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
					const j = await r.json().catch(() => ({}));
					if (!r.ok || j.ok === false) { setVoiceErr((j && j.error) || "删除失败"); return; }
				} catch (e) { setVoiceErr("删除失败：" + String((e && e.message) || e)); }
			};
			const handleTrain = async () => {
				setVoiceErr("");
				const fileEl = fileRef.current;
				const file = fileEl && fileEl.files && fileEl.files[0];
				if (!file) { setVoiceErr(tf("settings.voice.noFile")); return; }
				if (voiceList.length >= 5) { setVoiceErr(tf("settings.voice.full")); return; }
				try { const dur = await checkDur(file); if (dur > 30) { setVoiceErr(tf("settings.voice.tooLong")); return; } } catch { /* ignore */ }
				setVoiceBusy(true);
				try {
					const up = await fetch("/voice/voices/upload", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
					const upJ = await up.json().catch(() => ({}));
					if (!up.ok || !upJ.id) { setVoiceErr((upJ && upJ.error) || "上传失败"); setVoiceBusy(false); return; }
					const id = upJ.id;
					const tr = await fetch("/voice/voices/trim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
					const trJ = await tr.json().catch(() => ({}));
					if (!tr.ok || !trJ.segPath) { setVoiceErr((trJ && trJ.error) || "裁剪/识别失败"); setVoiceBusy(false); return; }
					setVoicePending({ id, segPath: trJ.segPath, text: trJ.text || "" });
					setVoiceBusy(false);
				} catch (e) { setVoiceBusy(false); setVoiceErr("处理失败：" + String((e && e.message) || e)); }
			};
			const handleCommit = async () => {
				const pv = voicePending;
				if (!pv) return;
				setVoiceErr("");
				setVoiceBusy(true);
				try {
					const name = (voiceName.trim() || voiceText.trim() || "音色").slice(0, 30);
					const cm = await fetch("/voice/voices/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pv.id, name, text: voiceText.trim() || pv.text }) });
					const cmJ = await cm.json().catch(() => ({}));
					if (!cm.ok || cmJ.ok === false) { setVoiceErr((cmJ && cmJ.error) || "入库失败"); setVoiceBusy(false); return; }
					setVoicePending(null); setVoiceName(""); setVoiceText(""); setVoiceBusy(false);
					if (fileRef.current) fileRef.current.value = "";
				} catch (e) { setVoiceBusy(false); setVoiceErr("入库失败：" + String((e && e.message) || e)); }
			};
			const handleMismatch = () => { setVoicePending(null); setVoiceText(""); setVoiceErr(tf("settings.voice.retryHint")); };
			const renderVoiceTab = () => {
				const rows = voiceList.map((v) => {
					const isSel = String(v.id) === voiceSelectedId;
					return (0, react_jsx_runtime.jsxs)("div", {
						key: v.id,
						style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
						children: [
							(0, react_jsx_runtime.jsx)("span", { style: { flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: v.name || v.id }),
							isSel ? (0, react_jsx_runtime.jsx)("span", { style: { color: "#2e7d32", fontSize: 12 }, children: tf("settings.voice.selected") }) : null,
							voicePreparing === String(v.id) ? (0, react_jsx_runtime.jsx)("span", { style: { color: "#e67e22", fontSize: 12, whiteSpace: "nowrap" }, children: tf("settings.voice.preparing") }) : null,
							(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: () => handleSelect(v.id), disabled: isSel || voicePreparing === String(v.id), style: btnStyle, children: tf("settings.voice.select") }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: () => handleDelete(v.id), style: btnStyle, children: tf("settings.voice.delete") })
						]
					});
				});
				return (0, react_jsx_runtime.jsxs)("div", {
					children: [
						(0, react_jsx_runtime.jsx)("div", { style: hintStyle, children: tf("settings.voice.title") + "（" + voiceList.length + "/5）" }),
						voiceList.length === 0
							? (0, react_jsx_runtime.jsx)("div", { style: hintStyle, children: tf("settings.voice.empty") })
							: (0, react_jsx_runtime.jsx)("div", { children: rows }),
						voiceErr ? (0, react_jsx_runtime.jsx)("div", { style: { color: "#c62828", fontSize: 12, marginBottom: 8 }, children: voiceErr }) : null,
						(0, react_jsx_runtime.jsxs)("div", { style: { marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }, children: [
							(0, react_jsx_runtime.jsx)("div", { style: labelStyle, children: tf("settings.voice.addTitle") }),
							(0, react_jsx_runtime.jsx)("input", { ref: fileRef, type: "file", accept: "audio/*", style: inputStyle }),
							(0, react_jsx_runtime.jsx)("input", { value: voiceName, onChange: (e) => setVoiceName(e.target.value), placeholder: tf("settings.voice.namePlaceholder"), style: { ...inputStyle, marginTop: 8 } }),
							(0, react_jsx_runtime.jsx)("textarea", { value: voiceText, onChange: (e) => setVoiceText(e.target.value), rows: 2, placeholder: tf("settings.voice.textPlaceholder"), style: { ...inputStyle, marginTop: 8, resize: "vertical", minHeight: 40 } }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: handleTrain, disabled: voiceBusy, style: { ...btnPrimary, marginTop: 8 }, children: voiceBusy ? tf("settings.voice.busy") : tf("settings.voice.train") })
						] }),
						voicePending ? (0, react_jsx_runtime.jsxs)("div", { style: { marginTop: 12, padding: 10, border: "1px solid #4d6bfe", borderRadius: 6, background: "rgba(77,107,254,0.06)" }, children: [
							(0, react_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 6 }, children: tf("settings.voice.recognized") }),
							(0, react_jsx_runtime.jsx)("audio", { controls: true, src: "/voice/voice_file?id=" + voicePending.id, style: { width: "100%", marginBottom: 8 } }),
							(0, react_jsx_runtime.jsxs)("div", { style: { marginBottom: 8, fontSize: 13 }, children: [
								(0, react_jsx_runtime.jsx)("span", { style: { fontWeight: 600 }, children: tf("settings.voice.recText") }),
								(0, react_jsx_runtime.jsx)("span", { children: (voicePending.text ? "：" + voicePending.text : "：(空，可在上方样本文字处补充)") })
							] }),
							(0, react_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
								(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: handleCommit, disabled: voiceBusy, style: btnPrimary, children: tf("settings.voice.confirm") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: handleMismatch, disabled: voiceBusy, style: btnStyle, children: tf("settings.voice.retry") })
							] })
						] }) : null
					]
				});
			};
			// 下拉显示值：已存值若在选项中就用它，否则回退到 fallback（或第一项），避免 value 不匹配。
			const selectVal = (key, options, fallback) => {
				const raw = String(valueAt(key));
				const vals = options.map((o) => o[0]);
				return vals.indexOf(raw) >= 0 ? raw : (fallback !== void 0 ? fallback : (vals[0] ?? ""));
			};
			const selectField = (key, label, options, fallback) => (0, react_jsx_runtime.jsxs)("label", {
				style: fieldWrap,
				children: [
					(0, react_jsx_runtime.jsx)("span", { style: labelStyle, children: label }),
					(0, react_jsx_runtime.jsxs)("select", {
						value: selectVal(key, options, fallback),
						onChange: (e) => setField(key, e.target.value),
						style: inputStyle,
						children: options.map((opt) => (0, react_jsx_runtime.jsx)("option", { key: opt[0], value: opt[0], style: { color: "#1a1a1a", background: "#ffffff" }, children: opt[1] }))
					})
				]
			});
			// 引擎模式 → 提示文案（本地=设备+本地引擎；API=填 key）。【engineMode 已在上方定义,此处仅保留注释】
			// 设备下拉：用宿主端真实检测的显卡/CPU 名称（nvidia-smi + os.cpus）；缺省或失败回退到自动+CPU。
			const deviceLabel = (id) => {
				if (id === "auto") return tf("settings.device.auto");
				if (id === "cpu") {
					const cn = String(devState.cpuName || "");
					return cn ? "CPU（" + cn + "）" : tf("settings.device.cpu");
				}
				const m = /^gpu:(\d+)$/.exec(id);
				if (m) {
					const n = Number(m[1]);
					const g = (devState.gpus || []).find((x) => x.index === n);
					const gn = (g && g.name) ? String(g.name) : (n === 0 ? tf("settings.device.gpu0") : (n === 1 ? tf("settings.device.gpu1") : "GPU " + n));
					return gn + "（卡 " + n + "）";
				}
				return id;
			};
			const deviceOptions = (() => {
				const list = (devState.status === "ok" && Array.isArray(devState.devices) && devState.devices.length) ? devState.devices : ["auto", "cpu"];
				const seen = []; const opts = [];
				for (const d of list) { if (seen.indexOf(d) < 0) { seen.push(d); opts.push([d, deviceLabel(d)]); } }
				return opts;
			})();
			const deviceHint = devState.status === "loading" ? tf("settings.detect.loading") : (devState.status === "error" ? tf("settings.detect.failed") : null);
			// 模型下拉：只显示宿主端真实检测到的本机模型；"云端"始终保留（引擎=API 时必需）。
			const modelLabel = (id) => {
				const m = (modelState.models || []).find((x) => x.id === id);
				if (m && m.label) return m.label;
				return id;
			};
			const modelOptions = (kind) => {
				// 【API 模式联动】选 API 时 TTS/STT 模型下拉只保留"云端"(锁定)。本地模式显示本地检测到的模型。
				if (engineMode === "api") {
					const cloudLabel = kind === "tts" ? tf("settings.tts.cloud") : tf("settings.stt.cloud");
					return [["cloud", cloudLabel]];
				}
				const availIds = (modelState.models || []).filter((m) => m.kind === kind && m.available).map((m) => m.id);
				const opts = availIds.map((id) => [id, modelLabel(id)]);
				const cloudLabel = kind === "tts" ? tf("settings.tts.cloud") : tf("settings.stt.cloud");
				if (opts.every((o) => o[0] !== "cloud")) opts.push(["cloud", cloudLabel]);
				return opts;
			};
			const ttsOptions = modelOptions("tts");
			const sttOptions = modelOptions("stt");
			const ttsFallback = ttsOptions[0] ? ttsOptions[0][0] : "cloud";
			const sttFallback = sttOptions[0] ? sttOptions[0][0] : "cloud";
			const modelHint = modelState.status === "loading" ? tf("settings.detect.loading") : (modelState.status === "error" ? tf("settings.detect.failed") : null);
			// 【TTS 服务商 → 音色克隆支持提示】按已知情况标: 支持/不支持/需确认(不误导用户)。
			// 依据: MiniMax/阿里云CosyVoice 有克隆API; OpenAI 官方无克隆; 硅基流动的克隆支持随模型/接口而异(需确认)。
			const ttsVendorSel = String(valueAt("ttsVendor") || "");
			const ttsVendorCloneSupport = ttsVendorSel === "minimax" || ttsVendorSel === "cosyvoice" ? "yes"
				: ttsVendorSel === "openai" ? "no"
				: ttsVendorSel === "" ? "none"
				: "maybe"; // siliconflow/other → 需确认
			const ttsVendorHint = ttsVendorCloneSupport === "yes" ? tf("settings.api.cloneYes")
				: ttsVendorCloneSupport === "no" ? tf("settings.api.cloneNo")
				: ttsVendorCloneSupport === "maybe" ? tf("settings.api.cloneMaybe")
				: tf("settings.api.cloneNone");
			// 各标签的实际控件（都经 valueAt/setField 读写 scope）。
			const renderTabs = (key) => {
				if (key === "voice") {
					return renderVoiceTab();
				}
				if (key === "device") {
					return (0, react_jsx_runtime.jsxs)("div", { children: [
						deviceHint ? (0, react_jsx_runtime.jsx)("div", { style: hintStyle, children: deviceHint }) : null,
						selectField("deviceId", tf("settings.field.deviceId"), deviceOptions, deviceOptions[0] ? deviceOptions[0][0] : "auto")
					] });
				}
				if (key === "model") {
					return (0, react_jsx_runtime.jsxs)("div", { children: [
						selectField("engineMode", tf("settings.field.engineMode"),
							[["local", tf("settings.engineMode.local")], ["api", tf("settings.engineMode.api")]],
							"local"),
						(0, react_jsx_runtime.jsx)("div", { style: hintStyle, children: engineMode === "api" ? tf("settings.hint.engineApi") : tf("settings.hint.engineLocal") }),
						modelHint ? (0, react_jsx_runtime.jsx)("div", { style: hintStyle, children: modelHint }) : null,
						selectField("llmEffort", tf("settings.field.llmEffort"),
							[["auto", tf("settings.effort.auto")], ["fast", tf("settings.effort.fast")], ["deep", tf("settings.effort.deep")]],
							"auto"),
						selectField("ttsModel", tf("settings.field.ttsModel"), ttsOptions, ttsFallback),
						selectField("sttModel", tf("settings.field.sttModel"), sttOptions, sttFallback),
						(0, react_jsx_runtime.jsxs)("div", { style: { marginTop: 16, borderTop: "1px solid #eee", paddingTop: 12 }, children: [
							(0, react_jsx_runtime.jsx)("div", { style: labelStyle, children: engineMode === "api" ? "云端 API 连接" : "本地引擎开关" }),
							(0, react_jsx_runtime.jsx)("div", { style: hintStyle, children: engineMode === "api"
								? "连接=检测该 API Key 是否有效并启用；断开=不再使用该云端。STT/TTS 填的 Key 相同(同一家)时，一个连接/断开会同时作用于两者。"
								: "停止后语音识别/合成暂不可用（省显存）；启动后首次调用约需 10 秒加载模型。" }),
							engState.err ? (0, react_jsx_runtime.jsx)("div", { style: { color: "#c62828", fontSize: 12, marginBottom: 8 }, children: engState.err }) : null,
							engineRow("stt", engineMode === "api" ? "STT 识别（云端 API）" : "STT 识别（SenseVoice · 9881）"),
							engineRow("tts", engineMode === "api" ? "TTS 合成（云端 API）" : "TTS 合成（CosyVoice · 9882）")
						] })
					] });
				}
				return (0, react_jsx_runtime.jsxs)("div", { children: [
					// 【API 模式·双 Key】STT/TTS 可能不同云端,各填各的 key。仅引擎模式=API 时可编辑(本地模式禁用)。
					// 按 key 是否相同判"同一家":相同 → 下方模型启禁用联动(一个启全启/一个禁全禁)。
					...(engineMode !== "api" ? [(0, react_jsx_runtime.jsx)("div", { style: { ...hintStyle, color: "#c62828" }, children: tf("settings.api.needApiMode") })] : []),
					// 【服务商选择 + 克隆支持提示】先选 TTS/STT 服务商,系统按已知情况提示该家是否支持音色克隆,
					// 避免用户以为能用克隆结果不能(不支持/需确认的会明确提示,只能用默认音色)。
					(0, react_jsx_runtime.jsxs)("label", { style: fieldWrap, children: [
						(0, react_jsx_runtime.jsx)("span", { style: labelStyle, children: tf("settings.api.ttsVendor") }),
						(0, react_jsx_runtime.jsxs)("select", {
							value: String(valueAt("ttsVendor") || ""),
							onChange: (e) => setField("ttsVendor", e.target.value),
							disabled: engineMode !== "api",
							style: { ...inputStyle, opacity: engineMode !== "api" ? 0.5 : 1 },
							children: [
								(0, react_jsx_runtime.jsx)("option", { value: "", style: { color: "#1a1a1a", background: "#ffffff" }, children: tf("settings.api.vendorNone") }),
								(0, react_jsx_runtime.jsx)("option", { value: "minimax", style: { color: "#1a1a1a", background: "#ffffff" }, children: "MiniMax（支持音色克隆）" }),
								(0, react_jsx_runtime.jsx)("option", { value: "cosyvoice", style: { color: "#1a1a1a", background: "#ffffff" }, children: "阿里云 CosyVoice（支持克隆）" }),
								(0, react_jsx_runtime.jsx)("option", { value: "siliconflow", style: { color: "#1a1a1a", background: "#ffffff" }, children: "硅基流动（克隆支持需确认）" }),
								(0, react_jsx_runtime.jsx)("option", { value: "openai", style: { color: "#1a1a1a", background: "#ffffff" }, children: "OpenAI 官方（不支持克隆）" }),
								(0, react_jsx_runtime.jsx)("option", { value: "other", style: { color: "#1a1a1a", background: "#ffffff" }, children: tf("settings.api.vendorOther") })
							]
						})
					] }),
					// 【克隆支持提示】按 TTS 服务商决定:支持/不支持/需确认。
					(0, react_jsx_runtime.jsx)("div", { style: { ...hintStyle, marginTop: -8, marginBottom: 8, color: ttsVendorCloneSupport === "yes" ? "#2e7d32" : (ttsVendorCloneSupport === "no" ? "#c62828" : "#e67e22") }, children: ttsVendorHint }),
					(0, react_jsx_runtime.jsxs)("label", { style: fieldWrap, children: [
						(0, react_jsx_runtime.jsx)("span", { style: labelStyle, children: tf("settings.api.sttVendor") }),
						(0, react_jsx_runtime.jsxs)("select", {
							value: String(valueAt("sttVendor") || ""),
							onChange: (e) => setField("sttVendor", e.target.value),
							disabled: engineMode !== "api",
							style: { ...inputStyle, opacity: engineMode !== "api" ? 0.5 : 1 },
							children: [
								(0, react_jsx_runtime.jsx)("option", { value: "", style: { color: "#1a1a1a", background: "#ffffff" }, children: tf("settings.api.vendorNone") }),
								(0, react_jsx_runtime.jsx)("option", { value: "openai-compatible", style: { color: "#1a1a1a", background: "#ffffff" }, children: "OpenAI 兼容语音识别" }),
								(0, react_jsx_runtime.jsx)("option", { value: "minimax", style: { color: "#1a1a1a", background: "#ffffff" }, children: "MiniMax" }),
								(0, react_jsx_runtime.jsx)("option", { value: "cosyvoice", style: { color: "#1a1a1a", background: "#ffffff" }, children: "阿里云 CosyVoice" }),
								(0, react_jsx_runtime.jsx)("option", { value: "other", style: { color: "#1a1a1a", background: "#ffffff" }, children: tf("settings.api.vendorOther") })
							]
						})
					] }),
					(0, react_jsx_runtime.jsxs)("label", { style: fieldWrap, children: [
						(0, react_jsx_runtime.jsx)("span", { style: labelStyle, children: tf("settings.api.sttKey") }),
						(0, react_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
							(0, react_jsx_runtime.jsx)("input", {
								type: showKey ? "text" : "password",
								value: String(valueAt("sttApiKey")),
								onChange: (e) => setField("sttApiKey", e.target.value),
								disabled: engineMode !== "api",
								style: { ...inputStyle, flex: 1, opacity: engineMode !== "api" ? 0.5 : 1 }
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setShowKey((v) => !v),
								style: { whiteSpace: "nowrap", padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 },
								children: showKey ? tf("settings.api.hideKey") : tf("settings.api.showKey")
							})
						] })
					] }),
					(0, react_jsx_runtime.jsx)("div", { style: { ...hintStyle, marginTop: -8, marginBottom: 8 }, children: tf("settings.api.baseUrlNote") }),
					(0, react_jsx_runtime.jsxs)("label", { style: fieldWrap, children: [
						(0, react_jsx_runtime.jsx)("span", { style: labelStyle, children: tf("settings.api.sttUrl") }),
						(0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: String(valueAt("sttBaseUrl")),
							onChange: (e) => setField("sttBaseUrl", e.target.value),
							disabled: engineMode !== "api",
							placeholder: "https://api.example.com/v1",
							style: { ...inputStyle, opacity: engineMode !== "api" ? 0.5 : 1 }
						})
					] }),
					(0, react_jsx_runtime.jsxs)("label", { style: fieldWrap, children: [
						(0, react_jsx_runtime.jsx)("span", { style: labelStyle, children: tf("settings.api.ttsKey") }),
						(0, react_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
							(0, react_jsx_runtime.jsx)("input", {
								type: showKey ? "text" : "password",
								value: String(valueAt("ttsApiKey")),
								onChange: (e) => setField("ttsApiKey", e.target.value),
								disabled: engineMode !== "api",
								style: { ...inputStyle, flex: 1, opacity: engineMode !== "api" ? 0.5 : 1 }
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setShowKey((v) => !v),
								style: { whiteSpace: "nowrap", padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 },
								children: showKey ? tf("settings.api.hideKey") : tf("settings.api.showKey")
							})
						] })
					] }),
					(0, react_jsx_runtime.jsxs)("label", { style: fieldWrap, children: [
						(0, react_jsx_runtime.jsx)("span", { style: labelStyle, children: tf("settings.api.ttsUrl") }),
						(0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: String(valueAt("ttsBaseUrl")),
							onChange: (e) => setField("ttsBaseUrl", e.target.value),
							disabled: engineMode !== "api",
							placeholder: "https://api.example.com/v1",
							style: { ...inputStyle, opacity: engineMode !== "api" ? 0.5 : 1 }
						})
					] }),
					(0, react_jsx_runtime.jsx)("div", { style: hintStyle, children: tf("settings.api.note") })
				] });
			};
			const tabs = [{ key: "voice" }, { key: "device" }, { key: "model" }, { key: "api" }];
			return (0, react_jsx_runtime.jsxs)("div", {
				style: { padding: "16px 0" },
				children: [
					(0, react_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 12, borderBottom: "1px solid #ddd", marginBottom: 16 }, children:
						tabs.map((item) => (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => setTab(item.key),
							style: {
								padding: "8px 12px", cursor: "pointer", background: "transparent", border: "none",
								borderBottom: item.key === tab ? "2px solid #4d6bfe" : "2px solid transparent",
								color: item.key === tab ? "#4d6bfe" : "#888", fontSize: 14
							},
							"aria-selected": item.key === tab,
							children: tf("settings.tab." + item.key)
						}))
					}),
					(0, react_jsx_runtime.jsxs)("div", { children: [
						renderTabs(tab),
						(0, react_jsx_runtime.jsxs)("div", { style: { marginTop: 16, display: "flex", alignItems: "center", gap: 12 }, children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: save,
								disabled: Object.keys(draft).length === 0,
								style: { padding: "8px 18px", borderRadius: 6, border: "none", background: "#4d6bfe", color: "#fff", cursor: "pointer" },
								children: tf("settings.save")
							}),
							saved ? (0, react_jsx_runtime.jsx)("span", { style: { color: "#2e7d32", fontSize: 12 }, children: tf("settings.saved") }) : null
						] })
					] })
				]
			});
		}
		//#region src/client/locales.ts
		/**
		* `voice` namespace dictionaries for the mic control.
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"mic.label": "语音输入",
			"mic.title": "语音输入（点击说话，说完自动停止；按住说话，松开发送）",
			"mic.title.listening": "正在聆听…（说完自动停止）",
			"mic.title.reading": "正在朗读回复…（点击麦克风停止）",
			"mic.chat.title": "语音对话（按住说话，松开发送；回复自动朗读）",
			"mic.unsupported": "当前浏览器不支持语音输入",
			"settings.nav": "语音",
			"settings.tab.voice": "音色",
			"settings.tab.device": "设备",
			"settings.tab.model": "模型",
			"settings.tab.api": "API",
			"settings.save": "保存",
			"settings.saved": "已保存",
			"settings.unavailable": "设置暂不可用",
			"settings.field.engineMode": "引擎模式",
			"settings.field.deviceId": "设备 ID",
			"settings.field.apiKey": "API Key",
			"settings.field.ttsModel": "TTS 模型",
			"settings.field.sttModel": "STT 模型",
			"settings.field.refAudioPath": "参考音频路径",
			"settings.field.promptText": "参考文本",
			"settings.engineMode.local": "本地",
			"settings.engineMode.api": "API",
			"settings.field.llmEffort": "LLM 档位",
			"settings.device.auto": "自动",
			"settings.device.gpu0": "GPU卡0",
			"settings.device.gpu1": "GPU卡1",
			"settings.device.cpu": "CPU",
			"settings.effort.auto": "自动",
			"settings.effort.fast": "快答",
			"settings.effort.deep": "深思",
			"settings.tts.local": "本地 CosyVoice",
			"settings.tts.cloud": "云端",
			"settings.stt.sensevoice": "SenseVoice",
			"settings.stt.whisper": "whisper",
			"settings.stt.cloud": "云端",
			"settings.hint.engineLocal": "本地引擎：使用本机推理，需在「设备」页选择显卡。",
			"settings.hint.engineApi": "云端 API：需在「API」页填入 API Key。",
			"settings.api.note": "仅在引擎模式为「API」（走云端）时需要填写。",
			"settings.api.showKey": "显示",
			"settings.api.hideKey": "隐藏",
			"settings.api.sttKey": "STT 识别 API Key",
			"settings.api.ttsKey": "TTS 合成 API Key",
			"settings.api.sttUrl": "STT API 服务地址（可选）",
			"settings.api.ttsUrl": "TTS API 服务地址（可选）",
			"settings.api.baseUrlNote": "服务地址填 API 的根地址（如 https://api.xxx.com/v1），留空则只校验 Key 是否填写、不做真实连通测试。",
			"settings.api.needApiMode": "当前引擎模式为「本地」。需先在「模型」页把引擎模式切为 API，才能填写云端 Key。",
			"settings.api.ttsVendor": "TTS 云端服务商",
			"settings.api.sttVendor": "STT 云端服务商",
			"settings.api.vendorNone": "（未选择）",
			"settings.api.vendorOther": "其它/自定义（需自行确认）",
			"settings.api.cloneYes": "✓ 该 TTS 服务支持音色克隆：可上传你的参考音频克隆（云端模式可用你的声音）。",
			"settings.api.cloneNo": "✗ 该 TTS 服务（OpenAI 官方）不支持音色克隆：只能用默认音色。",
			"settings.api.cloneMaybe": "？ 该 TTS 服务的音色克隆支持随模型/接口而异：请自行确认；若确认支持克隆，把参考音频按该家文档上传。",
			"settings.api.cloneNone": "请先选择 TTS 服务商，才知道是否支持音色克隆。",
			"settings.detect.loading": "正在检测本机设备/模型…",
			"settings.detect.failed": "检测失败，已用默认项",
			"settings.voice.title": "已训练音色",
			"settings.voice.empty": "暂无音色，请先上传样本并完成训练。",
			"settings.voice.addTitle": "新增音色（上传样本）",
			"settings.voice.namePlaceholder": "音色名称（可选，默认用样本文字）",
			"settings.voice.textPlaceholder": "样本文字（与音频内容一致，作为 prompt_text）",
			"settings.voice.train": "训练",
			"settings.voice.busy": "处理中…",
			"settings.voice.select": "选择",
			"settings.voice.delete": "删除",
			"settings.voice.selected": "当前",
			"settings.voice.full": "已满 5 个音色，请先删除一个。",
			"settings.voice.noFile": "请先选择音频文件。",
			"settings.voice.tooLong": "音频过长（超过 30 秒），请重新选择。",
			"settings.voice.recognized": "识别结果（可试听裁剪片段）",
			"settings.voice.recText": "识别文字",
			"settings.voice.confirm": "确认入库",
			"settings.voice.retry": "识别有误，重来",
			"settings.voice.retryHint": "识别可能与样本不符，请重新上传并校准文案。",
			"settings.voice.deleteConfirm": "确定删除该音色吗？",
			"settings.voice.preparing": "正在准备音色…"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"mic.label": "Voice input",
			"mic.title": "Voice input (click to speak; hold to talk, release to send)",
			"mic.title.listening": "Listening… (auto-stops on silence)",
			"mic.title.reading": "Reading the reply aloud… (tap the mic to stop)",
			"mic.chat.title": "Voice chat (hold to talk, release to send; reply read aloud)",
			"mic.unsupported": "Voice input is not supported in this browser",
			"settings.nav": "Voice",
			"settings.tab.voice": "Voice",
			"settings.tab.device": "Device",
			"settings.tab.model": "Model",
			"settings.tab.api": "API",
			"settings.save": "Save",
			"settings.saved": "Saved",
			"settings.unavailable": "Settings unavailable",
			"settings.field.engineMode": "Engine mode",
			"settings.field.deviceId": "Device ID",
			"settings.field.apiKey": "API Key",
			"settings.field.ttsModel": "TTS model",
			"settings.field.sttModel": "STT model",
			"settings.field.refAudioPath": "Reference audio path",
			"settings.field.promptText": "Reference text",
			"settings.engineMode.local": "Local",
			"settings.engineMode.api": "API",
			"settings.field.llmEffort": "LLM effort",
			"settings.device.auto": "Auto",
			"settings.device.gpu0": "GPU 0",
			"settings.device.gpu1": "GPU 1",
			"settings.device.cpu": "CPU",
			"settings.effort.auto": "Auto",
			"settings.effort.fast": "Fast",
			"settings.effort.deep": "Deep",
			"settings.tts.local": "Local CosyVoice",
			"settings.tts.cloud": "Cloud",
			"settings.stt.sensevoice": "SenseVoice",
			"settings.stt.whisper": "whisper",
			"settings.stt.cloud": "Cloud",
			"settings.hint.engineLocal": "Local engine: uses this machine's inference; choose a GPU on the Device tab.",
			"settings.hint.engineApi": "Cloud API: enter an API Key on the API tab.",
			"settings.api.note": "Only required when the Engine mode is API (cloud).",
			"settings.api.showKey": "Show",
			"settings.api.hideKey": "Hide",
			"settings.detect.loading": "Detecting local devices/models…",
			"settings.detect.failed": "Detection failed; using default options",
			"settings.voice.title": "Trained voices",
			"settings.voice.empty": "No voice yet. Upload a sample and train it.",
			"settings.voice.addTitle": "Add voice (upload sample)",
			"settings.voice.namePlaceholder": "Voice name (optional; defaults to sample text)",
			"settings.voice.textPlaceholder": "Sample text (must match the audio; used as prompt_text)",
			"settings.voice.train": "Train",
			"settings.voice.busy": "Working…",
			"settings.voice.select": "Select",
			"settings.voice.delete": "Delete",
			"settings.voice.selected": "Current",
			"settings.voice.full": "5 voices already. Delete one first.",
			"settings.voice.noFile": "Select an audio file first.",
			"settings.voice.tooLong": "Audio too long (>30s). Please pick another.",
			"settings.voice.recognized": "Recognition (preview the trimmed clip)",
			"settings.voice.recText": "Recognized text",
			"settings.voice.confirm": "Confirm",
			"settings.voice.retry": "Wrong text, retry",
			"settings.voice.retryHint": "Recognition may not match the sample. Re-upload and calibrate the text.",
			"settings.voice.deleteConfirm": "Delete this voice?",
			"settings.voice.preparing": "Preparing voice…"
		};
		//#endregion
		//#region src/client/index.ts
		const NS = "voice";
		/** Apply config defaults (client plugins resolve their own Config). */
		function resolveMicConfig(config = {}) {
			return {
				language: config.language ?? "zh-CN",
				interimResults: config.interimResults ?? true
			};
		}
		const inject = ["slots", "locale", "sessions", "connection", "settingsScope"];
		/**
		* Register the mic control into the composer tool row.
		* @param ctx - the client context.
		* @param config - optional deployment configuration.
		*/
		function apply(ctx, config = {}) {
			const resolved = resolveMicConfig(config);
			// 【设置页】locale 绑定 + 设置命名空间 scope（settingsScope 由 dsh-client-ui-settings 提供）。
			const t = ctx.locale.bind(NS);
			const voiceScope = ctx.settingsScope.bind({ namespace: "voice-input" });
			// 【音色】把 scope 存到模块级，供 TTS speaker 实时读"当前选中音色 id"(切音色即刻生效)。
			voiceSettingsScope = voiceScope;
			// 【📞常驻引擎】捕获会话域引用,供常驻朗读引擎跨会话订阅"通话归属会话 A"的 snapshot。
			sessionsRef = ctx.sessions;
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-voice-input: dictionaries");
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "voice-input",
				order: 100,
				locale: NS,
				inject: (sessionId) => {
					// 用 sessionId 拿到 session-scoped conversation,才能正确 cancel(取消当前生成)。
					// 全局 ctx.conversation 无 session scope,cancel() 会抛错 —— 按下即打断必须 session-scoped。
					let cancel = void 0;
					try {
						const actx = ctx.sessions.scope(sessionId);
						const conversation = actx?.get("conversation");
						if (conversation) cancel = () => conversation.cancel();
					} catch (e) {
						console.warn("[dsh-voice] resolve scoped conversation failed", e?.message);
					}
					return { ...resolved, cancel, sessionId };
				}
			}, MicButton));
			// 【📞自动接话】独立通话按钮,与话筒并存;点{on}后开始自动接话(你说完→自动交agent→读回复)。
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "voice-call",
				order: 90,
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					// 【模型接口修正·0.1.2】ctx.get("connection") 在 slot inject 闭包里已不可达(undefined → 席位崩溃)。
					// 0.1.2 官方(ui-model-selection)直接用 ctx.sessions.selectModel({sessionId, provider, model, reasoningEffort});
					// sessions 服务已在本插件 inject 声明,apply 层直接可拿(同 3117 行),闭包引用即可,不再连 connection。
					sessions: ctx.sessions,
				})
			}, TelButton));
			// 【设置页骨架】注册"语音"设置页。四标签壳，先只做"显示当前值 + 写字段 + 保存"。
			// namespace 必须已在宿主端（lib/index.js）注册，否则这里 scope 读到 status:"unavailable"。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "voice",
				order: 20,
				label: () => t("settings.nav"),
				inject: () => ({
					scope: voiceScope,
					t
				})
			}, VoiceSettingsPage));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.resolveMicConfig = resolveMicConfig;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map