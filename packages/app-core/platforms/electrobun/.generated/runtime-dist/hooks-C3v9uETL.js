import { D as require_jsx_runtime, E as require_index_cjs, S as invokeDesktopBridgeRequest, T as subscribeDesktopBridgeEvent, _ as getTalkModePlugin, b as getElectrobunRendererRpc, n as isElectrobunRuntime } from "./electrobun-runtime-zXJ9acDW.js";
import { D as getElizaApiBase, N as getBootConfig, O as getElizaApiToken, d as client, n as useApp, w as mergeStreamingText } from "./useApp-Dh-r7aR7.js";
import { G as PREMADE_VOICES, Gr as ttsDebug, Ir as useChatInputRef, Kr as ttsDebugTextPreview, Wr as isTtsDebugEnabled, et as appendSavedCustomCommand, it as loadSavedCustomCommands, nr as asRecord$1, q as hasConfiguredApiKey, ua as resolveApiUrl, zi as CHAT_AVATAR_VOICE_EVENT } from "./state-BC9WO-N8.js";
import { resolveStylePresetByAvatarIndex, resolveStylePresetById, sanitizeSpeechText } from "@elizaos/shared";
import { formatShortcut } from "@elizaos/ui";
import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useChatAvatarVoiceBridge.js
/**
* Pushes voice analysis from {@link useVoiceChat} to the companion avatar via
* {@link CHAT_AVATAR_VOICE_EVENT} and syncs speaking state into chat shell state.
*/
function useChatAvatarVoiceBridge({ mouthOpen, isSpeaking, onSpeakingChange }) {
	const prevSpeakingRef = useRef(isSpeaking);
	useEffect(() => {
		if (prevSpeakingRef.current !== isSpeaking) {
			prevSpeakingRef.current = isSpeaking;
			onSpeakingChange(isSpeaking);
		}
	}, [isSpeaking, onSpeakingChange]);
	useEffect(() => {
		const detail = {
			mouthOpen,
			isSpeaking
		};
		window.dispatchEvent(new CustomEvent(CHAT_AVATAR_VOICE_EVENT, { detail }));
	}, [mouthOpen, isSpeaking]);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/voice/character-voice-config.js
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const LEGACY_CHARACTER_VOICE_PRESET_IDS = {
	jin: "adam",
	kei: "josh",
	momo: "alice",
	rin: "matilda",
	ryu: "daniel",
	satoshi: "brian",
	yuki: "lily"
};
function readString(record, key) {
	const value = record?.[key];
	return typeof value === "string" ? value.trim() : "";
}
function readNumber(record, key) {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function resolveStoredVoiceConfig(config) {
	const tts = asRecord$1(asRecord$1(config.messages)?.tts);
	return tts ? tts : null;
}
function resolveSelectedCharacterVoiceId(config, uiLanguage) {
	const ui = asRecord$1(config.ui);
	const preset = resolveStylePresetById(readString(ui, "presetId"), uiLanguage) ?? resolveStylePresetByAvatarIndex(readNumber(ui, "avatarIndex"), uiLanguage);
	if (!preset?.id || !preset.voicePresetId) return null;
	const voice = PREMADE_VOICES.find((entry) => entry.id === preset.voicePresetId);
	if (!voice) return null;
	return {
		characterId: preset.id,
		voiceId: voice.voiceId
	};
}
function resolveLegacyVoiceId(characterId) {
	const legacyPresetId = LEGACY_CHARACTER_VOICE_PRESET_IDS[characterId];
	if (!legacyPresetId) return null;
	return PREMADE_VOICES.find((entry) => entry.id === legacyPresetId)?.voiceId ?? null;
}
function resolveCharacterVoiceConfigFromAppConfig(args) {
	const storedVoiceConfig = resolveStoredVoiceConfig(args.config);
	const selectedCharacterVoice = resolveSelectedCharacterVoiceId(args.config, args.uiLanguage);
	if (!selectedCharacterVoice) return {
		voiceConfig: storedVoiceConfig,
		shouldPersist: false
	};
	if (storedVoiceConfig?.provider && storedVoiceConfig.provider !== "elevenlabs") return {
		voiceConfig: storedVoiceConfig,
		shouldPersist: false
	};
	const currentVoiceId = typeof storedVoiceConfig?.elevenlabs?.voiceId === "string" ? storedVoiceConfig.elevenlabs.voiceId.trim() : "";
	const legacyVoiceId = resolveLegacyVoiceId(selectedCharacterVoice.characterId);
	if (!(selectedCharacterVoice.voiceId !== currentVoiceId && (!currentVoiceId || currentVoiceId === DEFAULT_ELEVENLABS_VOICE_ID || currentVoiceId === legacyVoiceId))) return {
		voiceConfig: storedVoiceConfig,
		shouldPersist: false
	};
	return {
		voiceConfig: {
			...storedVoiceConfig,
			provider: "elevenlabs",
			elevenlabs: {
				...storedVoiceConfig?.elevenlabs ?? {},
				voiceId: selectedCharacterVoice.voiceId,
				modelId: storedVoiceConfig?.elevenlabs?.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID
			}
		},
		shouldPersist: true
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/voice-chat-types.js
/**
* Types, constants, and config interfaces for the voice chat system.
*/
/** Access browser SpeechRecognition APIs which may live under a vendor prefix. */
function getSpeechRecognitionCtor() {
	const w = window;
	return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}
const DEFAULT_ELEVEN_MODEL = "eleven_flash_v2_5";
const DEFAULT_ELEVEN_VOICE = "EXAVITQu4vr4xnSDxMaL";
const MAX_SPOKEN_CHARS = 360;
const MAX_CACHED_SEGMENTS = 128;
/** First assistant clip: start synthesis after this much speakable text (avoids one-word TTS). */
const ASSISTANT_TTS_FIRST_FLUSH_CHARS = 24;
/** Later clips: batch for better prosody (avoid token-thin slices). */
const ASSISTANT_TTS_MIN_CHUNK_CHARS = 88;
/** Merge rapid stream deltas into one request after a short pause. */
const ASSISTANT_TTS_DEBOUNCE_MS = 170;
/**
* Temporary safety switch:
* only speak assistant replies once the final text has arrived.
*
* This avoids garbled overlap when cloud text streaming and speech playback
* race each other on partial chunks.
*/
const ASSISTANT_TTS_FINAL_ONLY = true;
const TALKMODE_STOP_SETTLE_MS = 120;
const REDACTED_SECRET = "[REDACTED]";
const MOUTH_OPEN_STEP = .02;
const globalAudioCache = /* @__PURE__ */ new Map();
function resolveVoiceMode(mode, _cloudConnected, _apiKey) {
	if (mode) return mode;
	return "own-key";
}
function resolveVoiceProxyEndpoint(mode) {
	return resolveApiUrl(mode === "cloud" ? "/api/tts/cloud" : "/api/tts/elevenlabs");
}
/** For ELIZA_TTS_DEBUG: shows whether cloud TTS hits the API or the wrong (page) origin. */
function describeTtsCloudFetchTargetForDebug() {
	const target = resolveApiUrl("/api/tts/cloud");
	if (/^https?:\/\//i.test(target)) try {
		return `${new URL(target).origin} (absolute)`;
	} catch {
		return target.slice(0, 120);
	}
	return `${typeof window !== "undefined" ? window.location.origin : "(no-window)"}${target.startsWith("/") ? target : `/${target}`} — relative URL (TTS fetch goes to the UI host, not the app API). Set __ELIZAOS_API_BASE__ / session elizaos_api_base / boot apiBase to http://127.0.0.1:<apiPort>`;
}
function isRedactedSecret(value) {
	return typeof value === "string" && value.trim().toUpperCase() === REDACTED_SECRET;
}
function cloneVoiceConfig(config) {
	if (!config) return null;
	return {
		...config,
		elevenlabs: config.elevenlabs ? { ...config.elevenlabs } : void 0,
		edge: config.edge ? { ...config.edge } : void 0,
		openai: config.openai ? { ...config.openai } : void 0
	};
}
function resolveEffectiveVoiceConfig(config, options) {
	const cloudConnected = options?.cloudConnected === true;
	const base = cloneVoiceConfig(config) ?? {};
	const rawProvider = base.provider;
	const hasLegacyOpenAiProvider = rawProvider === "openai";
	let provider = (hasLegacyOpenAiProvider ? void 0 : rawProvider) ?? (base.elevenlabs ? "elevenlabs" : base.edge ? "edge" : void 0) ?? (cloudConnected ? "elevenlabs" : void 0);
	if (cloudConnected && (provider === "edge" || hasLegacyOpenAiProvider || provider === "simple-voice")) {
		ttsDebug("voiceConfig:upgrade_provider_for_cloud", { fromProvider: hasLegacyOpenAiProvider ? "openai" : provider });
		provider = "elevenlabs";
	}
	if (!provider) return null;
	if (provider !== "elevenlabs") return {
		...base,
		provider
	};
	const currentElevenLabs = base.elevenlabs ?? {};
	const mode = resolveVoiceMode(base.mode, cloudConnected, currentElevenLabs.apiKey);
	const elevenlabs = {
		...currentElevenLabs,
		voiceId: currentElevenLabs.voiceId ?? DEFAULT_ELEVEN_VOICE,
		modelId: currentElevenLabs.modelId ?? DEFAULT_ELEVEN_MODEL,
		stability: typeof currentElevenLabs.stability === "number" ? currentElevenLabs.stability : .5,
		similarityBoost: typeof currentElevenLabs.similarityBoost === "number" ? currentElevenLabs.similarityBoost : .75,
		speed: typeof currentElevenLabs.speed === "number" ? currentElevenLabs.speed : 1
	};
	const apiKey = typeof currentElevenLabs.apiKey === "string" ? currentElevenLabs.apiKey.trim() : "";
	if (mode === "own-key" && apiKey && !isRedactedSecret(apiKey)) elevenlabs.apiKey = currentElevenLabs.apiKey;
	else delete elevenlabs.apiKey;
	return {
		...base,
		provider,
		mode,
		elevenlabs
	};
}
function isAbortError(error) {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	return false;
}
/** ELIZA_TTS_DEBUG fields for OS/browser SpeechSynthesis (often Microsoft Edge on Windows). */
function webSpeechVoiceDebugFields(voice) {
	if (!voice) return {
		voiceName: "(engine default)",
		voiceURI: "(none)",
		engineGuess: "unknown"
	};
	const blob = `${voice.voiceURI} ${voice.name}`.toLowerCase();
	let engineGuess = "unknown";
	if (blob.includes("microsoft") || blob.includes("msedge") || blob.includes("edge-tts")) engineGuess = "microsoft-edge-family";
	else if (blob.includes("com.apple")) engineGuess = "apple-webkit";
	else if (blob.includes("google")) engineGuess = "google";
	const extended = voice;
	return {
		voiceName: voice.name,
		voiceURI: voice.voiceURI,
		voiceLang: voice.lang,
		voiceDefault: voice.default,
		voiceLocalService: typeof extended.localService === "boolean" ? extended.localService : void 0,
		engineGuess
	};
}
function normalizeSpeechLocale(input) {
	return input?.trim() || "en-US";
}
function localePrefix(locale) {
	return locale.toLowerCase().split("-")[0] || "en";
}
function matchesVoiceLocale(voice, targetLocale) {
	const target = targetLocale.toLowerCase();
	const voiceLang = voice.lang.toLowerCase();
	if (voiceLang === target) return true;
	const base = localePrefix(targetLocale);
	return voiceLang.startsWith(`${base}-`) || voiceLang === base;
}
function toArrayBuffer(bytes) {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out.buffer;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/voice-chat-playback.js
/**
* Playback / TTS logic for voice chat — text processing, sentence splitting,
* speech text extraction, and mouth animation helpers.
*/
function collapseWhitespace(input) {
	return input.replace(/\s+/g, " ").trim();
}
function normalizeCacheText(input) {
	return collapseWhitespace(input.normalize("NFKC")).toLowerCase();
}
function capSpeechLength(input) {
	if (input.length <= MAX_SPOKEN_CHARS) return input;
	const clipped = input.slice(0, MAX_SPOKEN_CHARS);
	const splitAt = clipped.lastIndexOf(" ");
	return `${(splitAt > 120 ? clipped.slice(0, splitAt) : clipped).trim()}...`;
}
/**
* Hidden XML block tags whose content should never be spoken.  During
* streaming the closing tag may not have arrived yet, so we strip from
* the opening tag to end-of-string (matching the display path's
* `HIDDEN_XML_BLOCK_RE` which uses `(?:</tag>|$)`).
*
* The upstream `sanitizeSpeechText` only strips *closed* `<think>` blocks,
* so an in-progress `<think>reasoning so far` leaks "reasoning so far"
* into the voice output.  We handle it here before sanitization.
*/
const HIDDEN_VOICE_BLOCK_RE = /<(think|thought|analysis|reasoning|scratchpad|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
function extractVoiceText(input) {
	let text = input;
	if (text.includes("<response>")) {
		const openTag = "<text>";
		const closeTag = "</text>";
		const start = text.indexOf(openTag);
		if (start >= 0) {
			const contentStart = start + 6;
			const end = text.indexOf(closeTag, contentStart);
			text = end >= 0 ? text.slice(contentStart, end) : text.slice(contentStart);
		} else return "";
	}
	text = text.replace(HIDDEN_VOICE_BLOCK_RE, " ");
	text = text.replace(/\s{0,32}<actions>[\s\S]{0,16384}?(?:<\/actions>|$)\s{0,32}/g, " ");
	text = text.replace(/\s{0,32}<params>[\s\S]{0,16384}?(?:<\/params>|$)\s{0,32}/g, " ");
	text = text.replace(/<\/?[a-zA-Z][^>]*$|<\/?$/s, "");
	return text;
}
function toSpeakableText(input) {
	const extracted = extractVoiceText(input);
	if (!extracted) return "";
	const normalized = sanitizeSpeechText(extracted);
	if (!normalized) return "";
	return capSpeechLength(normalized);
}
/** Common abbreviations that end with a period but are not sentence endings. */
const ABBREV_RE = /(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|approx|Prof|Rev|Gen|Sgt|Lt|Col|Maj|Capt|Corp|Pvt|Ave|Blvd|dept|est|govt|assn)$/;
/**
* Replace URLs with placeholders so their internal dots are not treated as
* sentence boundaries.  Returns the cleaned string and a restore function.
*/
function shelterUrls(input) {
	const urls = [];
	return {
		text: input.replace(/https?:\/\/\S+/g, (m) => {
			urls.push(m);
			return `__URL${urls.length - 1}__`;
		}),
		restore: (s) => s.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)] ?? _)
	};
}
/**
* Test whether a period match at `index` inside `value` is a real sentence
* boundary (not an abbreviation or decimal).
*/
function isRealSentenceEnd(value, matchIndex) {
	const previousChar = matchIndex > 0 ? value[matchIndex - 1] : void 0;
	const nextChar = matchIndex + 1 < value.length ? value[matchIndex + 1] : void 0;
	if (previousChar !== void 0 && /\d/.test(previousChar)) {
		if (nextChar !== void 0 && /\d/.test(nextChar)) return false;
	}
	const before = value.slice(0, matchIndex);
	if (ABBREV_RE.test(before)) return false;
	return true;
}
function splitFirstSentence(text) {
	const value = collapseWhitespace(text);
	if (!value) return {
		complete: false,
		firstSentence: "",
		remainder: ""
	};
	const { text: sheltered, restore } = shelterUrls(value);
	const boundary = /([.!?]+(?:["')\]]+)?)(?:\s|$)/g;
	let match = null;
	while (true) {
		match = boundary.exec(sheltered);
		if (!match || typeof match.index !== "number") break;
		if (match[1]?.[0] === ".") {
			if (match[1]?.length >= 3) continue;
			if (!isRealSentenceEnd(sheltered, match.index)) continue;
		}
		const endIndex = match.index + match[0].length;
		const firstSentence = restore(sheltered.slice(0, endIndex).trim());
		const remainder = restore(sheltered.slice(endIndex).trim());
		if (firstSentence.length > 0) return {
			complete: true,
			firstSentence,
			remainder
		};
	}
	if (value.length >= 180) {
		const window = value.slice(0, 180);
		const splitAt = window.lastIndexOf(" ");
		if (splitAt > 100) return {
			complete: true,
			firstSentence: window.slice(0, splitAt).trim(),
			remainder: value.slice(splitAt).trim()
		};
	}
	return {
		complete: false,
		firstSentence: value,
		remainder: ""
	};
}
function remainderAfter(fullText, firstSentence) {
	const full = collapseWhitespace(fullText);
	const first = collapseWhitespace(firstSentence);
	if (!full || !first) return full;
	if (full.startsWith(first)) return full.slice(first.length).trim();
	const lowerFull = full.toLowerCase();
	const lowerFirst = first.toLowerCase();
	if (lowerFull.startsWith(lowerFirst)) return full.slice(first.length).trim();
	const idx = lowerFull.indexOf(lowerFirst);
	if (idx >= 0) return full.slice(idx + first.length).trim();
	return "";
}
function queueableSpeechPrefix(text, isFinal) {
	const value = collapseWhitespace(text);
	if (!value) return "";
	if (isFinal) return value;
	const { text: sheltered, restore } = shelterUrls(value);
	let lastSentenceEnd = 0;
	const boundary = /([.!?]+(?:["')\]]+)?)(?:\s|$)/g;
	let match = null;
	while (true) {
		match = boundary.exec(sheltered);
		if (!match || typeof match.index !== "number") break;
		if (match[1]?.[0] === ".") {
			if (match[1]?.length >= 3) continue;
			if (!isRealSentenceEnd(sheltered, match.index)) continue;
		}
		lastSentenceEnd = match.index + match[0].length;
	}
	if (lastSentenceEnd > 0) return restore(sheltered.slice(0, lastSentenceEnd).trim());
	if (value.length >= 180) {
		const window = value.slice(0, 180);
		const splitAt = window.lastIndexOf(" ");
		if (splitAt > 100) return window.slice(0, splitAt).trim();
	}
	return "";
}
function normalizeMouthOpen(value) {
	const clamped = Math.max(0, Math.min(1, value));
	const stepped = Math.round(clamped / MOUTH_OPEN_STEP) * MOUTH_OPEN_STEP;
	return stepped < MOUTH_OPEN_STEP ? 0 : Math.min(1, stepped);
}
function nextIdleMouthOpen(currentValue) {
	const current = normalizeMouthOpen(currentValue);
	if (current <= MOUTH_OPEN_STEP) return 0;
	return Math.max(0, Math.min(current * .85, current - MOUTH_OPEN_STEP));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/voice-chat-recording.js
/**
* Recording / STT logic for voice chat — transcript merging and normalization.
*/
function normalizeTranscriptWord(word) {
	return word.normalize("NFKC").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}
function mergeTranscriptWindows(existing, incoming) {
	const left = collapseWhitespace(existing);
	const right = collapseWhitespace(incoming);
	if (!left) return right;
	if (!right) return left;
	const exactMerged = mergeStreamingText(left, right);
	if (exactMerged === right || exactMerged === left || exactMerged === `${left}${right}`) {
		const leftWords = left.split(" ");
		const rightWords = right.split(" ");
		const maxOverlap = Math.min(leftWords.length, rightWords.length);
		for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
			let matches = true;
			for (let index = 0; index < overlap; index += 1) {
				const leftWord = normalizeTranscriptWord(leftWords[leftWords.length - overlap + index] ?? "");
				const rightWord = normalizeTranscriptWord(rightWords[index] ?? "");
				if (!leftWord || !rightWord || leftWord !== rightWord) {
					matches = false;
					break;
				}
			}
			if (!matches) continue;
			if (overlap === rightWords.length) return left;
			return [...leftWords, ...rightWords.slice(overlap)].join(" ");
		}
	}
	return exactMerged;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useVoiceChat.js
var import_index_cjs = require_index_cjs();
let sharedAudioCtx = null;
function shouldPreferNativeTalkMode() {
	if (typeof window === "undefined") return false;
	return import_index_cjs.Capacitor.isNativePlatform() || !!getElectrobunRendererRpc();
}
function isWindowsElectrobunRenderer() {
	return typeof window !== "undefined" && !!getElectrobunRendererRpc() && typeof process !== "undefined" && process.platform === "win32";
}
function shouldAutoRestartBrowserRecognition() {
	if (typeof window === "undefined") return false;
	if (isWindowsElectrobunRenderer()) return false;
	return true;
}
const __voiceChatInternals = {
	isWindowsElectrobunRenderer,
	shouldPreferNativeTalkMode,
	shouldAutoRestartBrowserRecognition,
	splitFirstSentence,
	remainderAfter,
	queueableSpeechPrefix,
	resolveEffectiveVoiceConfig,
	resolveVoiceMode,
	resolveVoiceProxyEndpoint,
	toSpeakableText,
	mergeTranscriptWindows,
	webSpeechVoiceDebugFields,
	ASSISTANT_TTS_FINAL_ONLY,
	ASSISTANT_TTS_FIRST_FLUSH_CHARS,
	ASSISTANT_TTS_MIN_CHUNK_CHARS
};
function useVoiceChat(options) {
	const [isListening, setIsListening] = useState(false);
	const [captureMode, setCaptureMode] = useState("idle");
	const [isSpeaking, setIsSpeaking] = useState(false);
	const [mouthOpen, setMouthOpen] = useState(0);
	const [interimTranscript, setInterimTranscript] = useState("");
	const [supported, setSupported] = useState(false);
	const [usingAudioAnalysis, setUsingAudioAnalysis] = useState(false);
	const [voiceUnlockedGeneration, setVoiceUnlockedGeneration] = useState(0);
	const recognitionRef = useRef(null);
	const sttBackendRef = useRef(null);
	const talkModeHandlesRef = useRef([]);
	const synthRef = useRef(null);
	const utteranceRef = useRef(null);
	const animFrameRef = useRef(0);
	const speakingStartRef = useRef(0);
	const speechTimeoutRef = useRef(null);
	const enabledRef = useRef(false);
	const listeningModeRef = useRef("idle");
	const transcriptBufferRef = useRef("");
	const emitTranscript = useEffectEvent((text) => {
		options.onTranscript(text);
	});
	const emitTranscriptPreview = useEffectEvent((text, event) => {
		options.onTranscriptPreview?.(text, event);
	});
	const emitPlaybackStart = useEffectEvent((event) => {
		options.onPlaybackStart?.(event);
	});
	const effectiveVoiceConfig = useMemo(() => resolveEffectiveVoiceConfig(options.voiceConfig, { cloudConnected: options.cloudConnected }), [options.cloudConnected, options.voiceConfig]);
	const assistantTtsQuality = useMemo(() => {
		return effectiveVoiceConfig?.provider === "elevenlabs" ? "enhanced" : "standard";
	}, [effectiveVoiceConfig?.provider]);
	const ttsDebugConfigKeyRef = useRef("");
	useEffect(() => {
		const key = JSON.stringify({
			c: options.cloudConnected,
			p: effectiveVoiceConfig?.provider,
			m: effectiveVoiceConfig?.mode,
			v: effectiveVoiceConfig?.elevenlabs?.voiceId,
			q: assistantTtsQuality
		});
		if (ttsDebugConfigKeyRef.current === key) return;
		ttsDebugConfigKeyRef.current = key;
		ttsDebug("useVoiceChat:config", {
			cloudConnected: options.cloudConnected,
			provider: effectiveVoiceConfig?.provider,
			mode: effectiveVoiceConfig?.mode,
			voiceId: effectiveVoiceConfig?.elevenlabs?.voiceId,
			assistantTtsQuality,
			ttsCloudUrl: resolveApiUrl("/api/tts/cloud")
		});
	}, [
		assistantTtsQuality,
		effectiveVoiceConfig?.elevenlabs?.voiceId,
		effectiveVoiceConfig?.mode,
		effectiveVoiceConfig?.provider,
		options.cloudConnected
	]);
	const voiceConfigRef = useRef(effectiveVoiceConfig);
	voiceConfigRef.current = effectiveVoiceConfig;
	const interruptOnSpeechRef = useRef(options.interruptOnSpeech ?? true);
	interruptOnSpeechRef.current = options.interruptOnSpeech ?? true;
	const interruptSpeechRef = useRef(() => {});
	const analyserRef = useRef(null);
	const audioSourceRef = useRef(null);
	const timeDomainDataRef = useRef(null);
	const usingAudioAnalysisRef = useRef(false);
	const mouthOpenRef = useRef(0);
	mouthOpenRef.current = mouthOpen;
	const queueRef = useRef([]);
	const queueWorkerRunningRef = useRef(false);
	const generationRef = useRef(0);
	const activeTaskFinishRef = useRef(null);
	const activeFetchAbortRef = useRef(null);
	const assistantSpeechRef = useRef(null);
	const assistantTtsDebounceRef = useRef(null);
	const clearSpeechTimers = useCallback(() => {
		if (speechTimeoutRef.current) {
			clearTimeout(speechTimeoutRef.current);
			speechTimeoutRef.current = null;
		}
	}, []);
	const rememberCachedSegment = useCallback((key, bytes) => {
		globalAudioCache.delete(key);
		globalAudioCache.set(key, bytes);
		if (globalAudioCache.size <= MAX_CACHED_SEGMENTS) return;
		const oldest = globalAudioCache.keys().next().value;
		if (oldest) globalAudioCache.delete(oldest);
	}, []);
	const makeElevenCacheKey = useCallback((text, config) => {
		return [
			"elevenlabs",
			config.voiceId ?? DEFAULT_ELEVEN_VOICE,
			config.modelId ?? DEFAULT_ELEVEN_MODEL,
			typeof config.stability === "number" ? config.stability.toFixed(2) : "0.50",
			typeof config.similarityBoost === "number" ? config.similarityBoost.toFixed(2) : "0.75",
			typeof config.speed === "number" ? config.speed.toFixed(2) : "1.00",
			normalizeCacheText(text)
		].join("|");
	}, []);
	const updateMouthOpen = useCallback((value) => {
		const previousValue = mouthOpenRef.current;
		const nextValue = normalizeMouthOpen(typeof value === "function" ? value(previousValue) : value);
		if (nextValue === previousValue) return;
		mouthOpenRef.current = nextValue;
		setMouthOpen(nextValue);
	}, []);
	useEffect(() => {
		let cancelled = false;
		const syncVoiceSupport = async () => {
			const browserSpeechSupported = !!getSpeechRecognitionCtor();
			if (!shouldPreferNativeTalkMode()) {
				if (!cancelled) setSupported(browserSpeechSupported);
				return;
			}
			try {
				const permissions = await getTalkModePlugin().checkPermissions();
				if (cancelled) return;
				setSupported(permissions.speechRecognition !== "not_supported" || browserSpeechSupported);
			} catch {
				if (!cancelled) setSupported(browserSpeechSupported);
			}
		};
		syncVoiceSupport();
		synthRef.current = window.speechSynthesis ?? null;
		return () => {
			cancelled = true;
		};
	}, []);
	useEffect(() => {
		let frameId = 0;
		const animate = () => {
			if (!isSpeaking) {
				const nextMouth = nextIdleMouthOpen(mouthOpenRef.current);
				updateMouthOpen(nextMouth);
				if (nextMouth > 0) {
					frameId = requestAnimationFrame(animate);
					animFrameRef.current = frameId;
				} else animFrameRef.current = 0;
				return;
			}
			if (usingAudioAnalysisRef.current) {
				const analyser = analyserRef.current;
				const data = timeDomainDataRef.current;
				if (analyser && data) {
					analyser.getFloatTimeDomainData(data);
					let sum = 0;
					for (let i = 0; i < data.length; i++) {
						const v = data[i] ?? 0;
						sum += v * v;
					}
					const rms = Math.sqrt(sum / data.length);
					updateMouthOpen(Math.max(0, Math.min(1, 1 / (1 + Math.exp(-(rms * 30 - 2))))));
				}
				frameId = requestAnimationFrame(animate);
				animFrameRef.current = frameId;
				return;
			}
			const sinceStart = Date.now() - speakingStartRef.current;
			if (sinceStart > 500 && synthRef.current && !synthRef.current.speaking && !synthRef.current.pending) {
				utteranceRef.current = null;
				setIsSpeaking(false);
				return;
			}
			const elapsed = sinceStart / 1e3;
			const base = Math.sin(elapsed * 12) * .3 + .4;
			const detail = Math.sin(elapsed * 18.7) * .15;
			const slow = Math.sin(elapsed * 4.2) * .1;
			updateMouthOpen(Math.max(0, Math.min(1, base + detail + slow)));
			frameId = requestAnimationFrame(animate);
			animFrameRef.current = frameId;
		};
		if (isSpeaking || mouthOpenRef.current > 0) {
			frameId = requestAnimationFrame(animate);
			animFrameRef.current = frameId;
		} else animFrameRef.current = 0;
		return () => {
			cancelAnimationFrame(frameId);
			if (animFrameRef.current === frameId) animFrameRef.current = 0;
		};
	}, [isSpeaking, updateMouthOpen]);
	const applyTranscriptUpdate = useCallback((transcript, isFinal) => {
		const mode = listeningModeRef.current;
		if (mode === "idle") return;
		const normalized = collapseWhitespace(transcript);
		if (!normalized) return;
		const nextText = mergeTranscriptWindows(transcriptBufferRef.current, normalized);
		if (nextText === transcriptBufferRef.current) return;
		transcriptBufferRef.current = nextText;
		setInterimTranscript(nextText);
		emitTranscriptPreview(nextText, {
			mode,
			isFinal
		});
		if (interruptOnSpeechRef.current) interruptSpeechRef.current();
	}, []);
	const removeTalkModeListeners = useCallback(async () => {
		const handles = talkModeHandlesRef.current;
		talkModeHandlesRef.current = [];
		await Promise.all(handles.map((handle) => handle.remove().catch(() => {})));
	}, []);
	const resetListeningState = useCallback(() => {
		transcriptBufferRef.current = "";
		recognitionRef.current = null;
		sttBackendRef.current = null;
		enabledRef.current = false;
		listeningModeRef.current = "idle";
		setIsListening(false);
		setCaptureMode("idle");
		setInterimTranscript("");
	}, []);
	const ensureTalkModeListeners = useCallback(async () => {
		if (talkModeHandlesRef.current.length > 0) return;
		const talkMode = getTalkModePlugin();
		talkModeHandlesRef.current = [
			await talkMode.addListener("transcript", (event) => {
				applyTranscriptUpdate(event.transcript ?? "", event.isFinal === true);
			}),
			await talkMode.addListener("error", (event) => {
				if (sttBackendRef.current === "talkmode" || event.code === "not-allowed" || event.code === "service-not-allowed") {
					resetListeningState();
					if (event.code === "not-allowed" || event.code === "service-not-allowed") setSupported(false);
				}
			}),
			await talkMode.addListener("stateChange", (event) => {
				if ((event.state === "error" || event.state === "idle") && sttBackendRef.current === "talkmode") resetListeningState();
			})
		];
	}, [applyTranscriptUpdate, resetListeningState]);
	const startBrowserRecognition = useCallback((mode) => {
		const SpeechRecognitionAPI = getSpeechRecognitionCtor();
		if (!SpeechRecognitionAPI) return false;
		const recognition = new SpeechRecognitionAPI();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = options.lang ?? "en-US";
		recognition.onresult = (event) => {
			let transcript = "";
			let isFinal = false;
			for (let index = 0; index < event.results.length; index += 1) {
				const result = event.results[index];
				const chunk = result?.[0]?.transcript ?? "";
				if (chunk) transcript = transcript ? `${transcript} ${chunk}` : chunk;
				if (result?.isFinal) isFinal = true;
			}
			applyTranscriptUpdate(transcript, isFinal);
		};
		recognition.onerror = (event) => {
			if (event.error === "not-allowed" || event.error === "service-not-allowed") {
				enabledRef.current = false;
				listeningModeRef.current = "idle";
				sttBackendRef.current = null;
				setCaptureMode("idle");
				setIsListening(false);
			}
		};
		recognition.onend = () => {
			if (shouldAutoRestartBrowserRecognition() && enabledRef.current && listeningModeRef.current === mode) try {
				recognition.start();
			} catch {}
		};
		recognitionRef.current = recognition;
		try {
			recognition.start();
			sttBackendRef.current = "browser";
			enabledRef.current = true;
			listeningModeRef.current = mode;
			setCaptureMode(mode);
			setIsListening(true);
			return true;
		} catch {
			recognitionRef.current = null;
			return false;
		}
	}, [applyTranscriptUpdate, options.lang]);
	const startTalkModeRecognition = useCallback(async (mode) => {
		if (!shouldPreferNativeTalkMode()) return false;
		await ensureTalkModeListeners();
		try {
			const talkMode = getTalkModePlugin();
			const browserSpeechSupported = !!getSpeechRecognitionCtor();
			let permissions = await talkMode.checkPermissions().catch(() => null);
			const nativeSpeechSupported = permissions?.speechRecognition !== "not_supported";
			if (!nativeSpeechSupported && !browserSpeechSupported) {
				console.warn("[useVoiceChat] No desktop or browser speech backend is available.");
				setSupported(false);
				return false;
			}
			if (permissions?.microphone === "prompt" && nativeSpeechSupported) {
				await talkMode.requestPermissions().catch(() => {});
				permissions = await talkMode.checkPermissions().catch(() => permissions);
			}
			const directRpc = getElectrobunRendererRpc();
			const result = await talkMode.start({ config: {
				stt: {
					...directRpc ? { engine: "whisper" } : {},
					language: options.lang ?? "en-US",
					modelSize: "base",
					sampleRate: 16e3
				},
				silenceWindowMs: 350,
				interruptOnSpeech: true
			} });
			if (!result.started) {
				console.warn("[useVoiceChat] TalkMode start returned not started.", {
					browserSpeechSupported,
					error: result.error
				});
				if (!browserSpeechSupported) setSupported(false);
				return false;
			}
			setSupported(true);
			enabledRef.current = true;
			listeningModeRef.current = mode;
			sttBackendRef.current = "talkmode";
			setCaptureMode(mode);
			setIsListening(true);
			return true;
		} catch (error) {
			console.warn("[useVoiceChat] TalkMode start failed.", error);
			return false;
		}
	}, [ensureTalkModeListeners, options.lang]);
	const finalizeRecognition = useCallback((submit) => {
		const transcript = collapseWhitespace(transcriptBufferRef.current);
		if (submit && transcript) emitTranscript(transcript);
		resetListeningState();
	}, [resetListeningState]);
	const startListening = useCallback(async (mode = "compose") => {
		if (enabledRef.current) return;
		transcriptBufferRef.current = "";
		setInterimTranscript("");
		if (interruptOnSpeechRef.current) interruptSpeechRef.current();
		if (shouldPreferNativeTalkMode()) {
			if (await startTalkModeRecognition(mode)) return;
		}
		if (!startBrowserRecognition(mode)) console.warn("[useVoiceChat] Voice capture failed to start in both desktop and browser backends.");
	}, [startBrowserRecognition, startTalkModeRecognition]);
	const stopListening = useCallback(async (options) => {
		if (listeningModeRef.current === "idle") return;
		const submit = options?.submit === true;
		enabledRef.current = false;
		if (sttBackendRef.current === "talkmode") {
			await getTalkModePlugin().stop().catch(() => {});
			await new Promise((resolve) => window.setTimeout(resolve, TALKMODE_STOP_SETTLE_MS));
		} else {
			recognitionRef.current?.stop();
			await new Promise((resolve) => window.setTimeout(resolve, TALKMODE_STOP_SETTLE_MS));
		}
		finalizeRecognition(submit);
	}, [finalizeRecognition]);
	const toggleListening = useCallback(() => {
		if (enabledRef.current && listeningModeRef.current === "compose") {
			stopListening();
			return;
		}
		if (enabledRef.current) return;
		startListening("compose");
	}, [startListening, stopListening]);
	/** Stop all in-progress speech playback/requests but keep assistant queue state. */
	const cancelPlayback = useCallback(() => {
		generationRef.current += 1;
		queueRef.current = [];
		activeFetchAbortRef.current?.abort();
		activeFetchAbortRef.current = null;
		activeTaskFinishRef.current?.();
		activeTaskFinishRef.current = null;
		synthRef.current?.cancel();
		utteranceRef.current = null;
		if (audioSourceRef.current) {
			try {
				audioSourceRef.current.stop();
			} catch {}
			try {
				audioSourceRef.current.disconnect();
			} catch {}
			audioSourceRef.current = null;
		}
		clearSpeechTimers();
		usingAudioAnalysisRef.current = false;
		setUsingAudioAnalysis(false);
	}, [clearSpeechTimers]);
	const stopSpeaking = useCallback(() => {
		if (assistantTtsDebounceRef.current != null) {
			clearTimeout(assistantTtsDebounceRef.current);
			assistantTtsDebounceRef.current = null;
		}
		assistantSpeechRef.current = null;
		cancelPlayback();
		setIsSpeaking(false);
		setUsingAudioAnalysis(false);
	}, [cancelPlayback]);
	interruptSpeechRef.current = stopSpeaking;
	const speakElevenLabs = useCallback(async (text, elConfig, task, generation) => {
		let ctx = sharedAudioCtx;
		if (!ctx) {
			ctx = new AudioContext();
			sharedAudioCtx = ctx;
		}
		if (ctx.state === "suspended") try {
			await ctx.resume();
		} catch {
			ctx.close().catch((err) => {
				console.warn("[useVoiceChat] AudioContext.close() failed", err);
			});
			ctx = new AudioContext();
			sharedAudioCtx = ctx;
		}
		const voiceId = elConfig.voiceId ?? DEFAULT_ELEVEN_VOICE;
		const modelId = elConfig.modelId ?? DEFAULT_ELEVEN_MODEL;
		const cacheKey = task.cacheKey ?? makeElevenCacheKey(text, elConfig);
		const cachedBytes = globalAudioCache.get(cacheKey);
		let audioBytes = null;
		let cached = false;
		if (cachedBytes) {
			rememberCachedSegment(cacheKey, cachedBytes);
			audioBytes = cachedBytes.slice();
			cached = true;
		}
		if (!audioBytes) {
			const controller = new AbortController();
			activeFetchAbortRef.current = controller;
			const requestBody = {
				text,
				model_id: modelId,
				apply_text_normalization: "auto",
				voice_settings: {
					stability: elConfig.stability ?? .5,
					similarity_boost: elConfig.similarityBoost ?? .75,
					speed: elConfig.speed ?? 1
				}
			};
			const apiToken = getElizaApiToken()?.trim() ?? "";
			const proxyRequestBody = JSON.stringify({
				...requestBody,
				voiceId,
				modelId,
				outputFormat: "mp3_44100_128"
			});
			/**
			* Server-side TTS when the browser has no `xi-api-key`.
			* Always try Eliza Cloud (`/api/tts/cloud`) first — that is where a
			* persisted Eliza Cloud API key is used. `voiceMode` may still be
			* `own-key` when the UI has not yet marked cloud as connected (e.g.
			* disconnect preference, status poll race), which previously routed
			* here to `/api/tts/elevenlabs` only; The framework does not implement that
			* path, so chat fell back to browser (Edge) TTS. If cloud rejects
			* (no key), fall back to the upstream ElevenLabs proxy.
			*/
			const makeProxyRequestInit = () => {
				const dbg = task.debugUtteranceContext;
				return {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "audio/mpeg",
						...apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
						...isTtsDebugEnabled() && dbg ? {
							"x-elizaos-tts-message-id": encodeURIComponent(dbg.messageId),
							"x-elizaos-tts-clip-segment": encodeURIComponent(task.segment),
							"x-elizaos-tts-full-preview": encodeURIComponent(dbg.fullAssistTextPreview)
						} : {}
					},
					body: proxyRequestBody,
					signal: controller.signal
				};
			};
			const shouldFallbackFromCloudProxy = (status) => status === 400 || status === 401 || status === 403 || status === 404 || status === 405 || status === 501;
			const fetchViaBestAvailableProxy = async () => {
				const cloudTarget = resolveApiUrl("/api/tts/cloud");
				try {
					const cloudRes = await fetch(cloudTarget, makeProxyRequestInit());
					if (cloudRes.ok || !shouldFallbackFromCloudProxy(cloudRes.status)) return cloudRes;
					ttsDebug("useVoiceChat:cloud-proxy-fallback", {
						status: cloudRes.status,
						ttsTarget: describeTtsCloudFetchTargetForDebug()
					});
				} catch (error) {
					ttsDebug("useVoiceChat:cloud-proxy-unavailable", {
						ttsTarget: describeTtsCloudFetchTargetForDebug(),
						error: error instanceof Error ? error.message : String(error)
					});
				}
				return await fetch(resolveApiUrl("/api/tts/elevenlabs"), makeProxyRequestInit());
			};
			const trimmedApiKey = typeof elConfig.apiKey === "string" ? elConfig.apiKey.trim() : "";
			const hasDirectKey = hasConfiguredApiKey(trimmedApiKey);
			let res;
			if (hasDirectKey) {
				try {
					const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
					url.searchParams.set("output_format", "mp3_44100_128");
					res = await fetch(url.toString(), {
						method: "POST",
						headers: {
							"xi-api-key": trimmedApiKey,
							"Content-Type": "application/json",
							Accept: "audio/mpeg"
						},
						body: JSON.stringify(requestBody),
						signal: controller.signal
					});
				} catch {
					res = await fetchViaBestAvailableProxy();
				}
				if (!res.ok && (res.status === 401 || res.status === 403)) {
					const proxyRes = await fetchViaBestAvailableProxy();
					if (proxyRes.ok) res = proxyRes;
				}
			} else res = await fetchViaBestAvailableProxy();
			if (activeFetchAbortRef.current === controller) activeFetchAbortRef.current = null;
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				ttsDebug("useVoiceChat:elevenlabs-http-error", {
					status: res.status,
					ttsTarget: describeTtsCloudFetchTargetForDebug(),
					hadBearer: Boolean(apiToken),
					bodyPreview: body.slice(0, 120)
				});
				throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
			}
			const audioData = await res.arrayBuffer();
			audioBytes = new Uint8Array(audioData);
			rememberCachedSegment(cacheKey, audioBytes.slice());
		}
		if (generation !== generationRef.current) return;
		const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(audioBytes));
		if (generation !== generationRef.current) return;
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 2048;
		analyser.smoothingTimeConstant = .8;
		analyserRef.current = analyser;
		timeDomainDataRef.current = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
		const source = ctx.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(analyser);
		analyser.connect(ctx.destination);
		audioSourceRef.current = source;
		await new Promise((resolve) => {
			let finished = false;
			const playStartMs = performance.now();
			let wrappedFinish = null;
			const finish = () => {
				if (finished) return;
				finished = true;
				if (wrappedFinish && activeTaskFinishRef.current === wrappedFinish) activeTaskFinishRef.current = null;
				if (audioSourceRef.current === source) audioSourceRef.current = null;
				source.onended = null;
				try {
					source.disconnect();
				} catch {}
				try {
					analyser.disconnect();
				} catch {}
				clearSpeechTimers();
				resolve();
			};
			wrappedFinish = () => {
				ttsDebug("play:web-audio:end", {
					segment: task.segment,
					elapsedMs: Math.round(performance.now() - playStartMs)
				});
				finish();
			};
			ttsDebug("play:web-audio:start", {
				segment: task.segment,
				append: task.append,
				cached,
				textChars: text.length,
				preview: ttsDebugTextPreview(text),
				durationSecApprox: Math.round(audioBuffer.duration * 100) / 100
			});
			activeTaskFinishRef.current = wrappedFinish;
			source.onended = wrappedFinish;
			speechTimeoutRef.current = setTimeout(wrappedFinish, Math.max(2500, Math.ceil(audioBuffer.duration * 1e3) + 1200));
			source.start(0);
			emitPlaybackStart({
				text,
				segment: task.segment,
				provider: "elevenlabs",
				cached,
				startedAtMs: playStartMs
			});
		});
	}, [
		clearSpeechTimers,
		makeElevenCacheKey,
		rememberCachedSegment
	]);
	const speakBrowser = useCallback((text, task, generation) => {
		const config = voiceConfigRef.current;
		const synth = synthRef.current;
		const requestedLocale = normalizeSpeechLocale(options.lang);
		const words = text.trim().split(/\s+/).length;
		const estimatedMs = Math.max(1200, words / 3 * 1e3);
		const useTalkModeTts = !synth && Boolean(getElectrobunRendererRpc());
		ttsDebug("speakBrowser:enter", {
			path: synth ? "speechSynthesis" : useTalkModeTts ? "talkmode-bridge" : "no-synth-timer-only",
			segment: task.segment,
			append: task.append,
			textChars: text.trim().length,
			preview: ttsDebugTextPreview(text),
			voiceConfigProvider: config?.provider ?? null,
			...config?.provider === "edge" && config.edge?.voice ? { edgeVoiceSetting: config.edge.voice } : {}
		});
		return new Promise((resolve) => {
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				if (activeTaskFinishRef.current === finish) activeTaskFinishRef.current = null;
				clearSpeechTimers();
				utteranceRef.current = null;
				resolve();
			};
			activeTaskFinishRef.current = finish;
			if (!synth) {
				if (getElectrobunRendererRpc()) {
					ttsDebug("play:talkmode:dispatch", {
						segment: task.segment,
						append: task.append,
						textChars: text.trim().length,
						preview: ttsDebugTextPreview(text),
						engine: "native-talkmode-bridge",
						note: "No window.speechSynthesis — routing TTS to main-process talkmodeSpeak"
					});
					invokeDesktopBridgeRequest({
						rpcMethod: "talkmodeSpeak",
						ipcChannel: "talkmode:speak",
						params: { text: text.trim() }
					}).catch((err) => {
						ttsDebug("play:talkmode:speak-failed", {
							segment: task.segment,
							preview: ttsDebugTextPreview(text),
							err: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err).slice(0, 200)
						});
						console.warn("[useVoiceChat] Desktop speech bridge failed:", err);
					});
				} else ttsDebug("play:browser:no-synth", {
					segment: task.segment,
					textChars: text.trim().length,
					preview: ttsDebugTextPreview(text),
					engine: "none",
					note: "No SpeechSynthesis — playback may be silent until Talk Mode or synth is available"
				});
				emitPlaybackStart({
					text,
					segment: task.segment,
					provider: "browser",
					cached: false,
					startedAtMs: performance.now()
				});
				speechTimeoutRef.current = setTimeout(finish, estimatedMs);
				return;
			}
			const utterance = new SpeechSynthesisUtterance(text.trim());
			utterance.lang = requestedLocale;
			utteranceRef.current = utterance;
			let selectedVoice;
			if (synth?.getVoices) {
				const voices = synth.getVoices();
				if (config?.provider === "edge" && config.edge?.voice) {
					const edgeVoiceName = config.edge.voice;
					selectedVoice = voices.find((v) => v.voiceURI === edgeVoiceName || v.name === edgeVoiceName);
					if (!selectedVoice) {
						const isMale = edgeVoiceName.toLowerCase().includes("guy") || edgeVoiceName.toLowerCase().includes("male");
						selectedVoice = voices.find((v) => {
							if (!matchesVoiceLocale(v, requestedLocale)) return false;
							const nameLower = v.name.toLowerCase();
							if (isMale) return nameLower.includes("male") || nameLower.includes("alex") || nameLower.includes("david") || nameLower.includes("daniel");
							else return nameLower.includes("female") || nameLower.includes("samantha") || nameLower.includes("victoria") || nameLower.includes("zira") || nameLower.includes("karen");
						});
					}
				}
				if (!selectedVoice) if (localePrefix(requestedLocale) === "en") selectedVoice = voices.find((v) => matchesVoiceLocale(v, requestedLocale) && !v.name.toLowerCase().includes("alex") && !v.name.toLowerCase().includes("david")) || voices.find((v) => matchesVoiceLocale(v, requestedLocale));
				else selectedVoice = voices.find((v) => matchesVoiceLocale(v, requestedLocale));
				if (selectedVoice) {
					utterance.voice = selectedVoice;
					utterance.lang = selectedVoice.lang || requestedLocale;
				}
			}
			utterance.rate = 1;
			utterance.pitch = 1;
			ttsDebug("play:browser:web-speech:enqueued", {
				segment: task.segment,
				append: task.append,
				textChars: text.trim().length,
				preview: ttsDebugTextPreview(text),
				requestedLocale,
				engine: "speechSynthesis",
				...webSpeechVoiceDebugFields(selectedVoice)
			});
			const browserPlayStartMsRef = { value: 0 };
			utterance.onstart = () => {
				if (generation !== generationRef.current) return;
				browserPlayStartMsRef.value = performance.now();
				ttsDebug("play:browser:speechSynthesis:start", {
					segment: task.segment,
					append: task.append,
					textChars: text.trim().length,
					preview: ttsDebugTextPreview(text),
					requestedLocale,
					engine: "speechSynthesis-utterance-onstart",
					...webSpeechVoiceDebugFields(selectedVoice)
				});
				emitPlaybackStart({
					text,
					segment: task.segment,
					provider: "browser",
					cached: false,
					startedAtMs: browserPlayStartMsRef.value
				});
			};
			const endBrowserUtterance = () => {
				if (browserPlayStartMsRef.value > 0) ttsDebug("play:browser:speechSynthesis:end", {
					segment: task.segment,
					elapsedMs: Math.round(performance.now() - browserPlayStartMsRef.value)
				});
				finish();
			};
			utterance.onend = endBrowserUtterance;
			utterance.onerror = (ev) => {
				const errEv = ev;
				ttsDebug("play:browser:speechSynthesis:error", {
					segment: task.segment,
					synthesisError: errEv.error ?? "unknown",
					preview: ttsDebugTextPreview(text),
					requestedLocale,
					...webSpeechVoiceDebugFields(selectedVoice)
				});
				endBrowserUtterance();
			};
			synth.speak(utterance);
			speechTimeoutRef.current = setTimeout(finish, estimatedMs + 5e3);
		});
	}, [clearSpeechTimers, options.lang]);
	const processQueue = useCallback(() => {
		if (queueWorkerRunningRef.current) return;
		queueWorkerRunningRef.current = true;
		const workerGeneration = generationRef.current;
		(async () => {
			try {
				while (queueRef.current.length > 0) {
					if (workerGeneration !== generationRef.current) break;
					const task = queueRef.current.shift();
					if (!task) break;
					const config = voiceConfigRef.current;
					const elConfig = config?.elevenlabs;
					const useElevenLabs = config?.provider === "elevenlabs";
					ttsDebug("processQueue:task", {
						useElevenLabs,
						hasElConfig: Boolean(elConfig),
						segment: task.segment,
						append: task.append,
						textChars: task.text.length,
						preview: ttsDebugTextPreview(task.text),
						...task.debugUtteranceContext ? {
							messageId: task.debugUtteranceContext.messageId,
							hearingFull: task.debugUtteranceContext.fullAssistTextPreview
						} : {}
					});
					if (useElevenLabs && elConfig) {
						usingAudioAnalysisRef.current = true;
						setUsingAudioAnalysis(true);
						try {
							await speakElevenLabs(task.text, elConfig, task, workerGeneration);
							continue;
						} catch (error) {
							if (workerGeneration !== generationRef.current || isAbortError(error)) break;
							console.warn("[useVoiceChat] ElevenLabs TTS failed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
							ttsDebug("useVoiceChat:elevenlabs-failed", {
								err: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : String(error).slice(0, 200),
								ttsTarget: describeTtsCloudFetchTargetForDebug(),
								hadBearer: Boolean(getElizaApiToken()?.trim())
							});
							usingAudioAnalysisRef.current = false;
							setUsingAudioAnalysis(false);
							throw error;
						}
					} else {
						usingAudioAnalysisRef.current = false;
						setUsingAudioAnalysis(false);
						ttsDebug("processQueue:browser-tts-direct", {
							reason: elConfig ? "provider_not_elevenlabs" : "missing_elevenlabs_config",
							provider: config?.provider ?? null,
							nextPath: "speakBrowser — OS Web Speech (often msedge/Microsoft) or Electrobun talkmode"
						});
					}
					await speakBrowser(task.text, task, workerGeneration);
				}
			} finally {
				queueWorkerRunningRef.current = false;
			}
			if (workerGeneration !== generationRef.current) return;
			if (queueRef.current.length > 0) {
				processQueue();
				return;
			}
			usingAudioAnalysisRef.current = false;
			setUsingAudioAnalysis(false);
			setIsSpeaking(false);
		})();
	}, [speakBrowser, speakElevenLabs]);
	const enqueueSpeech = useCallback((task) => {
		const speakable = toSpeakableText(task.text);
		if (!speakable) return;
		if (!task.append) cancelPlayback();
		queueRef.current.push({
			...task,
			text: speakable
		});
		ttsDebug("enqueueSpeech", {
			segment: task.segment,
			append: task.append,
			textChars: speakable.length,
			preview: ttsDebugTextPreview(speakable),
			queueLen: queueRef.current.length
		});
		speakingStartRef.current = Date.now();
		setIsSpeaking(true);
		processQueue();
	}, [cancelPlayback, processQueue]);
	const speak = useCallback((text, speakOptions) => {
		if (assistantTtsDebounceRef.current != null) {
			clearTimeout(assistantTtsDebounceRef.current);
			assistantTtsDebounceRef.current = null;
		}
		assistantSpeechRef.current = null;
		enqueueSpeech({
			text,
			append: Boolean(speakOptions?.append),
			segment: "full"
		});
	}, [enqueueSpeech]);
	const clearAssistantTtsDebounce = useCallback(() => {
		if (assistantTtsDebounceRef.current != null) {
			clearTimeout(assistantTtsDebounceRef.current);
			assistantTtsDebounceRef.current = null;
		}
	}, []);
	const flushPendingAssistantTts = useCallback(() => {
		assistantTtsDebounceRef.current = null;
		const state = assistantSpeechRef.current;
		if (!state || state.finalQueued) return;
		const latest = state.latestSpeakable;
		if (!latest) return;
		const unsent = remainderAfter(latest, state.queuedSpeakablePrefix);
		if (!unsent) return;
		const elConfig = voiceConfigRef.current?.elevenlabs;
		const cacheKey = voiceConfigRef.current?.provider === "elevenlabs" && elConfig ? makeElevenCacheKey(unsent, elConfig) : void 0;
		const dbgUtterance = isTtsDebugEnabled() ? {
			messageId: state.messageId,
			fullAssistTextPreview: ttsDebugTextPreview(latest, 220)
		} : void 0;
		const isFirstClip = state.queuedSpeakablePrefix.length === 0;
		enqueueSpeech({
			text: unsent,
			append: !isFirstClip,
			segment: isFirstClip ? "full" : "remainder",
			cacheKey,
			debugUtteranceContext: dbgUtterance
		});
		state.queuedSpeakablePrefix = latest;
	}, [enqueueSpeech, makeElevenCacheKey]);
	const queueAssistantSpeech = useCallback((messageId, text, isFinal) => {
		if (!messageId) return;
		const speakable = toSpeakableText(text);
		if (!speakable) {
			ttsDebug("queueAssistantSpeech:skip-empty", { messageId });
			return;
		}
		ttsDebug("queueAssistantSpeech", {
			messageId,
			isFinal,
			speakableChars: speakable.length,
			preview: ttsDebugTextPreview(speakable)
		});
		const current = assistantSpeechRef.current;
		if (!current || current.messageId !== messageId) {
			clearAssistantTtsDebounce();
			assistantSpeechRef.current = {
				messageId,
				queuedSpeakablePrefix: "",
				latestSpeakable: "",
				finalQueued: false
			};
		}
		const state = assistantSpeechRef.current;
		if (!state) return;
		state.latestSpeakable = speakable;
		if (ASSISTANT_TTS_FINAL_ONLY && !isFinal) return;
		if (ASSISTANT_TTS_FINAL_ONLY) {
			if (state.finalQueued) return;
			clearAssistantTtsDebounce();
			const elConfig = voiceConfigRef.current?.elevenlabs;
			enqueueSpeech({
				text: speakable,
				append: false,
				segment: "full",
				cacheKey: voiceConfigRef.current?.provider === "elevenlabs" && elConfig ? makeElevenCacheKey(speakable, elConfig) : void 0,
				debugUtteranceContext: isTtsDebugEnabled() ? {
					messageId,
					fullAssistTextPreview: ttsDebugTextPreview(speakable, 220)
				} : void 0
			});
			state.queuedSpeakablePrefix = speakable;
			state.finalQueued = true;
			return;
		}
		if (speakable === state.queuedSpeakablePrefix && (!isFinal || state.finalQueued)) return;
		if (speakable === state.queuedSpeakablePrefix && isFinal) {
			clearAssistantTtsDebounce();
			state.finalQueued = true;
			return;
		}
		const unsent = remainderAfter(speakable, state.queuedSpeakablePrefix);
		if (!unsent) {
			if (isFinal) {
				clearAssistantTtsDebounce();
				state.finalQueued = true;
			}
			return;
		}
		const isFirstClip = state.queuedSpeakablePrefix.length === 0;
		if (isFinal || isFirstClip && unsent.length >= ASSISTANT_TTS_FIRST_FLUSH_CHARS || !isFirstClip && unsent.length >= ASSISTANT_TTS_MIN_CHUNK_CHARS) {
			clearAssistantTtsDebounce();
			const elConfig = voiceConfigRef.current?.elevenlabs;
			const cacheKey = voiceConfigRef.current?.provider === "elevenlabs" && elConfig ? makeElevenCacheKey(unsent, elConfig) : void 0;
			const dbgUtterance = isTtsDebugEnabled() ? {
				messageId,
				fullAssistTextPreview: ttsDebugTextPreview(speakable, 220)
			} : void 0;
			enqueueSpeech({
				text: unsent,
				append: !isFirstClip,
				segment: isFirstClip ? "full" : "remainder",
				cacheKey,
				debugUtteranceContext: dbgUtterance
			});
			state.queuedSpeakablePrefix = speakable;
			if (isFinal) state.finalQueued = true;
			return;
		}
		clearAssistantTtsDebounce();
		assistantTtsDebounceRef.current = setTimeout(() => {
			flushPendingAssistantTts();
		}, ASSISTANT_TTS_DEBOUNCE_MS);
	}, [
		clearAssistantTtsDebounce,
		enqueueSpeech,
		flushPendingAssistantTts,
		makeElevenCacheKey
	]);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const handleUserGesture = () => {
			window.removeEventListener("pointerdown", handleUserGesture, true);
			window.removeEventListener("keydown", handleUserGesture, true);
			if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
			sharedAudioCtx.resume().catch(() => {});
			setVoiceUnlockedGeneration((g) => g + 1);
		};
		window.addEventListener("pointerdown", handleUserGesture, true);
		window.addEventListener("keydown", handleUserGesture, true);
		return () => {
			window.removeEventListener("pointerdown", handleUserGesture, true);
			window.removeEventListener("keydown", handleUserGesture, true);
		};
	}, []);
	useEffect(() => {
		return () => {
			stopListening();
			removeTalkModeListeners();
			stopSpeaking();
		};
	}, [
		removeTalkModeListeners,
		stopListening,
		stopSpeaking
	]);
	return {
		isListening,
		captureMode,
		isSpeaking,
		mouthOpen,
		interimTranscript,
		supported,
		usingAudioAnalysis,
		toggleListening,
		startListening,
		stopListening,
		speak,
		queueAssistantSpeech,
		stopSpeaking,
		voiceUnlockedGeneration,
		assistantTtsQuality
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useActivityEvents.js
/**
* Hook that subscribes to WebSocket activity events and maintains a ring buffer
* of recent entries for the chat widget rail.
*/
const RING_BUFFER_CAP = 200;
let nextEventId = 0;
function makeEventId() {
	nextEventId += 1;
	return `evt-${nextEventId}-${Date.now()}`;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function summarizeAssistantActivityEvent(data) {
	if (data.type !== "agent_event" || data.stream !== "assistant") return null;
	const payload = isRecord(data.payload) ? data.payload : null;
	if (!payload) return null;
	const source = typeof payload.source === "string" ? payload.source : "";
	const text = typeof payload.text === "string" ? payload.text.trim().slice(0, 120) : "";
	if (!text) return null;
	switch (source) {
		case "lifeops-reminder": return {
			eventType: "reminder",
			summary: text
		};
		case "lifeops-workflow": return {
			eventType: "workflow",
			summary: text
		};
		case "proactive-gm":
		case "proactive-gn": return {
			eventType: "check-in",
			summary: text
		};
		case "proactive-nudge": return {
			eventType: "nudge",
			summary: text
		};
		default: return null;
	}
}
/**
* Subscribe to task/proactive websocket events plus assistant activity events,
* returning a capped list of recent activity entries.
*/
function useActivityEvents() {
	const [events, setEvents] = useState([]);
	const bufferRef = useRef([]);
	const pushEvent = useCallback((entry) => {
		const event = {
			...entry,
			id: makeEventId()
		};
		const buf = bufferRef.current;
		buf.unshift(event);
		if (buf.length > RING_BUFFER_CAP) buf.length = RING_BUFFER_CAP;
		setEvents([...buf]);
	}, []);
	useEffect(() => {
		const unbindPty = client.onWsEvent("pty-session-event", (data) => {
			const eventType = data.eventType ?? data.type;
			const sessionId = data.sessionId;
			const d = data.data;
			let summary = eventType;
			if (eventType === "task_registered") summary = `Task started: ${d?.label ?? sessionId ?? "unknown"}`;
			else if (eventType === "task_complete" || eventType === "stopped") summary = `Task ${eventType === "task_complete" ? "completed" : "stopped"}`;
			else if (eventType === "tool_running") summary = `Running ${d?.description ?? d?.toolName ?? "tool"}`.slice(0, 80);
			else if (eventType === "blocked") summary = "Waiting for input";
			else if (eventType === "blocked_auto_resolved") summary = "Decision auto-approved";
			else if (eventType === "escalation") summary = "Escalated — needs attention";
			else if (eventType === "error") summary = "Error occurred";
			pushEvent({
				timestamp: Date.now(),
				eventType,
				sessionId: sessionId ?? void 0,
				summary
			});
		});
		const unbindProactive = client.onWsEvent("proactive-message", (data) => {
			const message = typeof data.message === "string" ? data.message.slice(0, 120) : "Proactive message";
			pushEvent({
				timestamp: Date.now(),
				eventType: "proactive-message",
				summary: message
			});
		});
		const unbindAgent = client.onWsEvent("agent_event", (data) => {
			const activity = summarizeAssistantActivityEvent(data);
			if (!activity) return;
			pushEvent({
				timestamp: Date.now(),
				eventType: activity.eventType,
				summary: activity.summary
			});
		});
		return () => {
			unbindPty();
			unbindProactive();
			unbindAgent();
		};
	}, [pushEvent]);
	return {
		events,
		clearEvents: useCallback(() => {
			bufferRef.current = [];
			setEvents([]);
		}, [])
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useBugReport.js
var import_jsx_runtime = require_jsx_runtime();
const BugReportContext = createContext(null);
function useOptionalBugReport() {
	return useContext(BugReportContext);
}
function useBugReport() {
	const ctx = useOptionalBugReport();
	if (!ctx) throw new Error("useBugReport must be used within BugReportProvider");
	return ctx;
}
function useBugReportState() {
	const [isOpen, setIsOpen] = useState(false);
	const [draft, setDraft] = useState(null);
	return {
		isOpen,
		draft,
		open: useCallback((nextDraft) => {
			setDraft(nextDraft ?? null);
			setIsOpen(true);
		}, []),
		close: useCallback(() => {
			setIsOpen(false);
			setDraft(null);
		}, [])
	};
}
function BugReportProvider({ children, value }) {
	return (0, import_jsx_runtime.jsx)(BugReportContext.Provider, {
		value,
		children
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useCanvasWindow.js
/**
* useCanvasWindow
*
* Creates a floating BrowserWindow (via the Electrobun canvas RPC) that is
* positioned and sized to match a DOM placeholder div.  The BrowserWindow
* appears to be "embedded" because it is always kept aligned with the div.
*
* Works in:
*   - Electrobun — calls via the preload-exposed renderer RPC
*   - Legacy desktop bridge compatibility — falls back to the historical bridge
*
* Falls back gracefully (isReady=false, no window created) when neither
* runtime is detected (web / Capacitor / SSR).
*/
function getScreenRect(el) {
	const rect = el.getBoundingClientRect();
	return {
		x: Math.round(rect.left + window.scrollX),
		y: Math.round(rect.top + window.scrollY),
		width: Math.round(rect.width),
		height: Math.round(rect.height)
	};
}
function useCanvasWindow(options) {
	const { url, enabled, title } = options;
	const containerRef = useRef(null);
	const windowIdRef = useRef(null);
	const [windowId, setWindowId] = useState(null);
	const [isReady, setIsReady] = useState(false);
	const urlRef = useRef(url);
	urlRef.current = url;
	const titleRef = useRef(title);
	titleRef.current = title;
	const lastBoundsRef = useRef(null);
	const syncFrameRef = useRef(null);
	const trackingFrameRef = useRef(null);
	const animationTrackerCountRef = useRef(0);
	const syncBounds = useCallback(() => {
		const el = containerRef.current;
		const id = windowIdRef.current;
		if (!el || !id) return;
		const bounds = getScreenRect(el);
		const last = lastBoundsRef.current;
		if (last && last.x === bounds.x && last.y === bounds.y && last.width === bounds.width && last.height === bounds.height) return;
		lastBoundsRef.current = bounds;
		invokeDesktopBridgeRequest({
			rpcMethod: "canvasSetBounds",
			ipcChannel: "canvas:setBounds",
			params: {
				id,
				...bounds
			}
		}).catch((err) => {
			console.warn("[useCanvasWindow] canvas:setBounds failed", err);
		});
	}, []);
	const scheduleSyncBounds = useCallback(() => {
		if (trackingFrameRef.current !== null || syncFrameRef.current !== null) return;
		syncFrameRef.current = requestAnimationFrame(() => {
			syncFrameRef.current = null;
			syncBounds();
		});
	}, [syncBounds]);
	const startTrackingBounds = useCallback(() => {
		if (trackingFrameRef.current !== null) return;
		const loop = () => {
			syncBounds();
			trackingFrameRef.current = requestAnimationFrame(loop);
		};
		trackingFrameRef.current = requestAnimationFrame(loop);
	}, [syncBounds]);
	const stopTrackingBounds = useCallback(() => {
		if (trackingFrameRef.current !== null) {
			cancelAnimationFrame(trackingFrameRef.current);
			trackingFrameRef.current = null;
		}
		if (syncFrameRef.current !== null) {
			cancelAnimationFrame(syncFrameRef.current);
			syncFrameRef.current = null;
		}
	}, []);
	useEffect(() => {
		if (!enabled) return;
		let destroyed = false;
		let createdId = null;
		const el = containerRef.current;
		const initial = el ? getScreenRect(el) : {
			x: 100,
			y: 100,
			width: 800,
			height: 600
		};
		invokeDesktopBridgeRequest({
			rpcMethod: "canvasCreateWindow",
			ipcChannel: "canvas:createWindow",
			params: {
				url: urlRef.current,
				title: titleRef.current ?? "Canvas",
				x: initial.x,
				y: initial.y,
				width: initial.width,
				height: initial.height
			}
		}).then((result) => {
			if (!result) return;
			if (destroyed) {
				const id = result.id;
				if (id) invokeDesktopBridgeRequest({
					rpcMethod: "canvasDestroyWindow",
					ipcChannel: "canvas:destroyWindow",
					params: { id }
				}).catch((err) => {
					console.warn("[useCanvasWindow] canvas:destroyWindow cleanup failed", err);
				});
				return;
			}
			const id = result.id;
			if (!id) {
				console.warn("[useCanvasWindow] canvasCreateWindow returned no id");
				return;
			}
			createdId = id;
			windowIdRef.current = id;
			setWindowId(id);
			lastBoundsRef.current = null;
			setIsReady(true);
			scheduleSyncBounds();
		}).catch((err) => {
			console.warn("[useCanvasWindow] canvas:createWindow failed", err);
		});
		const isTrackedTarget = (target) => {
			const trackedElement = containerRef.current;
			return trackedElement !== null && target instanceof Node && trackedElement.contains(target);
		};
		const handleViewportChange = () => {
			scheduleSyncBounds();
		};
		const startAnimationTracking = (event) => {
			if (!isTrackedTarget(event.target)) return;
			animationTrackerCountRef.current += 1;
			startTrackingBounds();
		};
		const stopAnimationTracking = (event) => {
			if (!isTrackedTarget(event.target)) return;
			animationTrackerCountRef.current = Math.max(0, animationTrackerCountRef.current - 1);
			if (animationTrackerCountRef.current === 0) {
				stopTrackingBounds();
				scheduleSyncBounds();
			}
		};
		window.addEventListener("resize", handleViewportChange);
		window.addEventListener("scroll", handleViewportChange, true);
		window.addEventListener("transitionstart", startAnimationTracking, true);
		window.addEventListener("transitionend", stopAnimationTracking, true);
		window.addEventListener("transitioncancel", stopAnimationTracking, true);
		window.addEventListener("animationstart", startAnimationTracking, true);
		window.addEventListener("animationend", stopAnimationTracking, true);
		window.addEventListener("animationcancel", stopAnimationTracking, true);
		window.visualViewport?.addEventListener("resize", handleViewportChange);
		window.visualViewport?.addEventListener("scroll", handleViewportChange);
		let ro = null;
		if (el && typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(() => {
				scheduleSyncBounds();
			});
			ro.observe(el);
		}
		return () => {
			destroyed = true;
			animationTrackerCountRef.current = 0;
			stopTrackingBounds();
			ro?.disconnect();
			window.removeEventListener("resize", handleViewportChange);
			window.removeEventListener("scroll", handleViewportChange, true);
			window.removeEventListener("transitionstart", startAnimationTracking, true);
			window.removeEventListener("transitionend", stopAnimationTracking, true);
			window.removeEventListener("transitioncancel", stopAnimationTracking, true);
			window.removeEventListener("animationstart", startAnimationTracking, true);
			window.removeEventListener("animationend", stopAnimationTracking, true);
			window.removeEventListener("animationcancel", stopAnimationTracking, true);
			window.visualViewport?.removeEventListener("resize", handleViewportChange);
			window.visualViewport?.removeEventListener("scroll", handleViewportChange);
			const id = createdId ?? windowIdRef.current;
			if (id) {
				windowIdRef.current = null;
				setWindowId(null);
				setIsReady(false);
				lastBoundsRef.current = null;
				invokeDesktopBridgeRequest({
					rpcMethod: "canvasDestroyWindow",
					ipcChannel: "canvas:destroyWindow",
					params: { id }
				}).catch((err) => {
					console.warn("[useCanvasWindow] canvas:destroyWindow teardown failed", err);
				});
			}
		};
	}, [
		enabled,
		scheduleSyncBounds,
		startTrackingBounds,
		stopTrackingBounds
	]);
	return {
		containerRef,
		windowId,
		isReady,
		navigate: useCallback((newUrl) => {
			const id = windowIdRef.current;
			if (!id) return;
			invokeDesktopBridgeRequest({
				rpcMethod: "canvasNavigate",
				ipcChannel: "canvas:navigate",
				params: {
					id,
					url: newUrl
				}
			}).catch((err) => {
				console.warn("[useCanvasWindow] canvas:navigate failed", err);
			});
		}, []),
		show: useCallback(() => {
			const id = windowIdRef.current;
			if (!id) return;
			invokeDesktopBridgeRequest({
				rpcMethod: "canvasShow",
				ipcChannel: "canvas:show",
				params: { id }
			}).catch((err) => {
				console.warn("[useCanvasWindow] canvas:show failed", err);
			});
		}, []),
		hide: useCallback(() => {
			const id = windowIdRef.current;
			if (!id) return;
			invokeDesktopBridgeRequest({
				rpcMethod: "canvasHide",
				ipcChannel: "canvas:hide",
				params: { id }
			}).catch((err) => {
				console.warn("[useCanvasWindow] canvas:hide failed", err);
			});
		}, [])
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useContextMenu.js
/**
* Listens for native desktop context-menu events
* and dispatches actions into the app state.
*/
/** Read saved custom commands from localStorage. */
function loadCustomCommands() {
	return loadSavedCustomCommands();
}
function getSelectedText(target) {
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		const start = target.selectionStart ?? 0;
		const end = target.selectionEnd ?? start;
		return target.value.slice(start, end).trim();
	}
	if (typeof window.getSelection === "function") return window.getSelection()?.toString().trim() ?? "";
	return "";
}
function useContextMenu() {
	const { setState, handleChatSend, setActionNotice } = useApp();
	const chatInputRef = useChatInputRef();
	const desktopRuntime = isElectrobunRuntime();
	const [saveCommandModalOpen, setSaveCommandModalOpen] = useState(false);
	const [saveCommandText, setSaveCommandText] = useState("");
	const [customCommands, setCustomCommands] = useState(loadCustomCommands);
	useEffect(() => {
		const onSaveAsCommand = (payload) => {
			const command = payload;
			if (!command?.text) return;
			setSaveCommandText(command.text);
			setSaveCommandModalOpen(true);
		};
		const onAskAgent = (payload) => {
			const command = payload;
			if (!command?.text) return;
			setState("chatInput", command.text);
			setTimeout(() => handleChatSend(), 0);
		};
		const onCreateSkill = (payload) => {
			const command = payload;
			if (!command?.text) return;
			setState("chatInput", `Create a skill from the following content:\n\n"""${command.text}"""\n\nAnalyze this and create a reusable skill.`);
			setTimeout(() => handleChatSend(), 0);
		};
		const onQuoteInChat = (payload) => {
			const command = payload;
			if (!command?.text) return;
			setState("chatInput", `> ${command.text}\n\n` + (chatInputRef?.current ?? ""));
		};
		const unsubscribers = [
			subscribeDesktopBridgeEvent({
				rpcMessage: "contextMenuSaveAsCommand",
				ipcChannel: "contextMenu:saveAsCommand",
				listener: onSaveAsCommand
			}),
			subscribeDesktopBridgeEvent({
				rpcMessage: "contextMenuAskAgent",
				ipcChannel: "contextMenu:askAgent",
				listener: onAskAgent
			}),
			subscribeDesktopBridgeEvent({
				rpcMessage: "contextMenuCreateSkill",
				ipcChannel: "contextMenu:createSkill",
				listener: onCreateSkill
			}),
			subscribeDesktopBridgeEvent({
				rpcMessage: "contextMenuQuoteInChat",
				ipcChannel: "contextMenu:quoteInChat",
				listener: onQuoteInChat
			})
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [
		setState,
		handleChatSend,
		chatInputRef
	]);
	useEffect(() => {
		if (!desktopRuntime || typeof window === "undefined") return;
		const onContextMenu = (event) => {
			if (event.defaultPrevented) return;
			const text = getSelectedText(event.target);
			if (!text) return;
			event.preventDefault();
			invokeDesktopBridgeRequest({
				rpcMethod: "desktopShowSelectionContextMenu",
				ipcChannel: "desktop:showSelectionContextMenu",
				params: { text }
			});
		};
		window.addEventListener("contextmenu", onContextMenu);
		return () => {
			window.removeEventListener("contextmenu", onContextMenu);
		};
	}, [desktopRuntime]);
	return {
		saveCommandModalOpen,
		saveCommandText,
		customCommands,
		closeSaveCommandModal: useCallback(() => {
			setSaveCommandModalOpen(false);
			setSaveCommandText("");
		}, []),
		confirmSaveCommand: useCallback((name) => {
			appendSavedCustomCommand({
				name,
				text: saveCommandText,
				createdAt: Date.now()
			});
			setCustomCommands(loadCustomCommands());
			setSaveCommandModalOpen(false);
			setSaveCommandText("");
			setActionNotice(`Saved /${name} command`, "success");
		}, [saveCommandText, setActionNotice])
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useKeyboardShortcuts.js
const COMMON_SHORTCUTS = [
	{
		key: "k",
		ctrl: true,
		description: "Open command palette",
		scope: "global"
	},
	{
		key: "Enter",
		ctrl: true,
		description: "Send message",
		scope: "chat"
	},
	{
		key: "Escape",
		description: "Close modal / Cancel",
		scope: "global"
	},
	{
		key: "?",
		shift: true,
		description: "Show keyboard shortcuts",
		scope: "global"
	},
	{
		key: "r",
		ctrl: true,
		description: "Restart agent",
		scope: "global"
	},
	{
		key: " ",
		description: "Pause/Resume agent",
		scope: "global"
	},
	{
		key: "t",
		ctrl: true,
		shift: true,
		description: "Toggle terminal",
		scope: "global"
	}
];
function useShortcutsHelp() {
	return COMMON_SHORTCUTS.map((s) => `${formatShortcut(s)} — ${s.description}`).join("\n");
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useMediaQuery.js
function getMediaQueryMatch(query) {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(query).matches;
}
function useMediaQuery(query, options) {
	const defaultValue = options?.defaultValue ?? false;
	return useSyncExternalStore(useCallback((onStoreChange) => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
		const mediaQuery = window.matchMedia(query);
		const handleChange = () => {
			onStoreChange();
		};
		if (typeof mediaQuery.addEventListener === "function") {
			mediaQuery.addEventListener("change", handleChange);
			return () => mediaQuery.removeEventListener("change", handleChange);
		}
		mediaQuery.addListener(handleChange);
		return () => mediaQuery.removeListener(handleChange);
	}, [query]), useCallback(() => getMediaQueryMatch(query), [query]), useCallback(() => defaultValue, [defaultValue]));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useMusicPlayer.js
/**
* Default guild/room id for plugin-music-player when Discord is not used.
* Keep in sync with `ELIZA_DESKTOP_MUSIC_GUILD_ID` in Electrobun `music-player.ts`.
*/
const ELIZA_DESKTOP_MUSIC_GUILD_ID = "elizaos-desktop";
/**
* Guild key used by plugin-music-player for web chat — must match
* `playAudio` / `queueMusic` (`web-${message.roomId}` when `room.serverId` is unset).
*/
function getWebMusicGuildIdFromRoomId(roomId) {
	const r = roomId?.trim();
	if (!r) return ELIZA_DESKTOP_MUSIC_GUILD_ID;
	return `web-${r}`;
}
function buildMusicPlayerPaths(guildId) {
	const g = encodeURIComponent(guildId);
	return {
		stream: `/music-player/stream?guildId=${g}`,
		file: `/music-player/file?guildId=${g}`,
		nowPlaying: `/music-player/now-playing?guildId=${g}`,
		queue: `/music-player/queue?guildId=${g}`
	};
}
/**
* Resolve the API base using the same chain as ElizaClient / resolveApiUrl:
* boot config → shell injection → sessionStorage → "" (same origin).
* An empty string means relative URLs go through the Vite dev proxy.
*/
function resolveApiBase() {
	const boot = getBootConfig().apiBase?.trim();
	if (boot) return boot;
	const injected = getElizaApiBase();
	if (injected) return injected;
	if (typeof window !== "undefined") {
		const stored = window.sessionStorage.getItem("elizaos_api_base")?.trim();
		if (stored) return stored;
	}
	return "";
}
/**
* Resolves absolute URLs for plugin-music-player HTTP routes.
* On Electrobun, prefers the main-process URL resolution (direct agent port).
* Otherwise uses the same API base chain as the rest of the app (boot config →
* shell injection → sessionStorage → same origin via empty string, which lets
* the Vite dev proxy forward `/music-player/*` to the agent).
*/
async function resolveMusicPlayerPlaybackUrls(options) {
	const guildId = options?.guildId?.trim() || ELIZA_DESKTOP_MUSIC_GUILD_ID;
	const desktop = await invokeDesktopBridgeRequest({
		rpcMethod: "musicPlayerGetDesktopPlaybackUrls",
		ipcChannel: "musicPlayer:getDesktopPlaybackUrls",
		params: { guildId }
	});
	if (desktop && desktop.ok === true && typeof desktop.streamUrl === "string" && typeof desktop.guildId === "string" && typeof desktop.apiBase === "string" && typeof desktop.nowPlayingUrl === "string" && typeof desktop.queueUrl === "string") return {
		ok: true,
		apiBase: desktop.apiBase,
		guildId: desktop.guildId,
		streamUrl: desktop.streamUrl,
		nowPlayingUrl: desktop.nowPlayingUrl,
		queueUrl: desktop.queueUrl
	};
	const root = resolveApiBase().replace(/\/$/, "");
	const paths = buildMusicPlayerPaths(guildId);
	return {
		ok: true,
		apiBase: root,
		guildId,
		streamUrl: `${root}${paths.stream}`,
		nowPlayingUrl: `${root}${paths.nowPlaying}`,
		queueUrl: `${root}${paths.queue}`
	};
}
/**
* Loads playback URLs for the music player stream. Use `attachStreamToAudioElement`
* to point an `<audio>` element at the Ogg Opus stream when a track is playing.
*/
function useMusicPlayerStream(options) {
	const guildId = options?.guildId ?? ELIZA_DESKTOP_MUSIC_GUILD_ID;
	const [urls, setUrls] = useState(null);
	useEffect(() => {
		let alive = true;
		resolveMusicPlayerPlaybackUrls({ guildId }).then((r) => {
			if (alive) setUrls(r);
		});
		return () => {
			alive = false;
		};
	}, [guildId]);
	return {
		urls,
		attachStreamToAudioElement: useCallback((el) => {
			if (!el || !urls?.ok) return;
			el.crossOrigin = "anonymous";
			if (el.src !== urls.streamUrl) {
				el.src = urls.streamUrl;
				el.load();
			}
		}, [urls])
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useRenderGuard.js
const THRESHOLD = 3;
const WINDOW_MS = 1e3;
const IS_DEV = typeof process !== "undefined" && false;
/**
* Development-only render-rate guard.
*
* Tracks render timestamps for the named component and logs a console warning
* when the component re-renders {@link THRESHOLD} or more times within
* {@link WINDOW_MS} ms.  No-op in production builds.
*
* Usage:
* ```ts
* function MyComponent() {
*   useRenderGuard("MyComponent");
*   // …
* }
* ```
*/
function useRenderGuard(name) {
	const timestamps = useRef([]);
	if (!IS_DEV) return;
	const now = Date.now();
	const ts = timestamps.current;
	ts.push(now);
	while (ts.length > 0 && ts[0] < now - WINDOW_MS) ts.shift();
	if (ts.length >= THRESHOLD) console.warn(`[RenderGuard] "${name}" rendered ${ts.length}× in the last ${WINDOW_MS}ms`);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useSignalPairing.js
const IDLE_SIGNAL_PAIRING_STATE = {
	status: "idle",
	qrDataUrl: null,
	phoneNumber: null,
	error: null
};
function stateFromStatusResponse(response) {
	return {
		status: response.status,
		qrDataUrl: response.qrDataUrl,
		phoneNumber: response.phoneNumber,
		error: response.error
	};
}
function toSignalPairingErrorState(error) {
	return {
		...IDLE_SIGNAL_PAIRING_STATE,
		status: "error",
		error: error instanceof Error ? error.message : String(error)
	};
}
function useSignalPairing(accountId = "default") {
	const [state, setState] = useState(IDLE_SIGNAL_PAIRING_STATE);
	useEffect(() => {
		let cancelled = false;
		client.getSignalStatus(accountId).then((response) => {
			if (cancelled) return;
			setState(stateFromStatusResponse(response));
		}).catch((error) => {
			if (cancelled) return;
			setState(toSignalPairingErrorState(error));
		});
		return () => {
			cancelled = true;
		};
	}, [accountId]);
	useEffect(() => {
		const unbindQr = client.onWsEvent("signal-qr", (data) => {
			if (data.accountId !== accountId) return;
			setState((prev) => ({
				...prev,
				status: "waiting_for_qr",
				qrDataUrl: data.qrDataUrl ?? null,
				error: null
			}));
		});
		const unbindStatus = client.onWsEvent("signal-status", (data) => {
			if (data.accountId !== accountId) return;
			const nextStatus = data.status;
			const clearQrDataUrl = nextStatus === "connected" || nextStatus === "disconnected" || nextStatus === "timeout" || nextStatus === "error";
			setState((prev) => ({
				...prev,
				status: nextStatus,
				phoneNumber: data.phoneNumber ?? prev.phoneNumber,
				error: data.error ?? null,
				qrDataUrl: clearQrDataUrl ? null : prev.qrDataUrl
			}));
		});
		return () => {
			unbindQr();
			unbindStatus();
		};
	}, [accountId]);
	const startPairing = useCallback(async () => {
		setState({
			status: "initializing",
			qrDataUrl: null,
			phoneNumber: null,
			error: null
		});
		try {
			const result = await client.startSignalPairing(accountId);
			if (result.ok) setState((prev) => ({
				...prev,
				status: result.status,
				error: null
			}));
			else setState((prev) => ({
				...prev,
				status: "error",
				error: result.error ?? "Failed to start Signal pairing"
			}));
		} catch (error) {
			setState((prev) => ({
				...prev,
				status: "error",
				error: error instanceof Error ? error.message : String(error)
			}));
		}
	}, [accountId]);
	const stopPairing = useCallback(async () => {
		try {
			await client.stopSignalPairing(accountId);
			setState(IDLE_SIGNAL_PAIRING_STATE);
		} catch (error) {
			setState(toSignalPairingErrorState(error));
		}
	}, [accountId]);
	const disconnect = useCallback(async () => {
		try {
			await client.disconnectSignal(accountId);
			setState(IDLE_SIGNAL_PAIRING_STATE);
		} catch (error) {
			setState(toSignalPairingErrorState(error));
		}
	}, [accountId]);
	return {
		...state,
		startPairing,
		stopPairing,
		disconnect
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useStreamPopoutNavigation.js
function getNextTabForStreamPopoutEvent(_detail) {
	return null;
}
function useStreamPopoutNavigation(_setTab) {}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useWhatsAppPairing.js
function useWhatsAppPairing(accountId = "default") {
	const [state, setState] = useState({
		status: "idle",
		qrDataUrl: null,
		phoneNumber: null,
		error: null
	});
	useEffect(() => {
		client.getWhatsAppStatus(accountId).then((res) => {
			if (res.authExists) setState((prev) => ({
				...prev,
				status: "connected"
			}));
		}).catch(() => {});
	}, [accountId]);
	useEffect(() => {
		const unbindQr = client.onWsEvent("whatsapp-qr", (data) => {
			if (data.accountId !== accountId) return;
			setState((prev) => ({
				...prev,
				status: "waiting_for_qr",
				qrDataUrl: data.qrDataUrl
			}));
		});
		const unbindStatus = client.onWsEvent("whatsapp-status", (data) => {
			if (data.accountId !== accountId) return;
			setState((prev) => ({
				...prev,
				status: data.status,
				phoneNumber: data.phoneNumber ?? prev.phoneNumber,
				error: data.error ?? null,
				qrDataUrl: data.status === "connected" ? null : prev.qrDataUrl
			}));
		});
		return () => {
			unbindQr();
			unbindStatus();
		};
	}, [accountId]);
	const startPairing = useCallback(async () => {
		setState({
			status: "initializing",
			qrDataUrl: null,
			phoneNumber: null,
			error: null
		});
		try {
			const result = await client.startWhatsAppPairing(accountId);
			if (!result.ok) setState((prev) => ({
				...prev,
				status: "error",
				error: result.error ?? "Failed to start pairing"
			}));
		} catch (err) {
			setState((prev) => ({
				...prev,
				status: "error",
				error: err instanceof Error ? err.message : String(err)
			}));
		}
	}, [accountId]);
	const stopPairing = useCallback(async () => {
		await client.stopWhatsAppPairing(accountId).catch(() => {});
		setState({
			status: "idle",
			qrDataUrl: null,
			phoneNumber: null,
			error: null
		});
	}, [accountId]);
	const disconnect = useCallback(async () => {
		await client.disconnectWhatsApp(accountId).catch(() => {});
		setState({
			status: "idle",
			qrDataUrl: null,
			phoneNumber: null,
			error: null
		});
	}, [accountId]);
	return {
		...state,
		startPairing,
		stopPairing,
		disconnect
	};
}

//#endregion
export { useVoiceChat as C, useChatAvatarVoiceBridge as E, __voiceChatInternals as S, resolveCharacterVoiceConfigFromAppConfig as T, BugReportProvider as _, useRenderGuard as a, useOptionalBugReport as b, getWebMusicGuildIdFromRoomId as c, useMediaQuery as d, COMMON_SHORTCUTS as f, useCanvasWindow as g, useContextMenu as h, useSignalPairing as i, resolveMusicPlayerPlaybackUrls as l, loadCustomCommands as m, getNextTabForStreamPopoutEvent as n, ELIZA_DESKTOP_MUSIC_GUILD_ID as o, useShortcutsHelp as p, useStreamPopoutNavigation as r, buildMusicPlayerPaths as s, useWhatsAppPairing as t, useMusicPlayerStream as u, useBugReport as v, nextIdleMouthOpen as w, useActivityEvents as x, useBugReportState as y };