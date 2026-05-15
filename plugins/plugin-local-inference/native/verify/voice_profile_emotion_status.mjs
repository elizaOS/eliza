#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const reportsRoot = resolve(pluginRoot, "native", "reports");
const verifyReportsRoot = resolve(pluginRoot, "native", "verify", "reports");
const SAMANTHA_PLACEHOLDER_BYTE_LENGTH = 1052;
const VOICE_PRESET_MAGIC = 0x315a4c45;
const VOICE_PRESET_VERSION_V1 = 1;
const VOICE_PRESET_VERSION_V2 = 2;
const VOICE_PRESET_HEADER_BYTES_V1 = 24;
const VOICE_PRESET_HEADER_BYTES_V2 = 64;
const DEFAULT_REFERENCE_TEXT = "Capital city reference voice sample.";

const REQUIRED_RUNTIME_SYMBOLS = [
	{
		key: "streamingTts",
		symbol: "eliza_inference_tts_synthesize_stream",
		requiredFor: "streaming TTS",
	},
	{
		key: "streamingAsr",
		symbol: "eliza_inference_asr_stream_open",
		requiredFor: "streaming ASR",
	},
	{
		key: "nativeVad",
		symbol: "eliza_inference_vad_process",
		requiredFor: "native VAD",
	},
	{
		key: "bargeInCancel",
		symbol: "eliza_inference_cancel_tts",
		requiredFor: "barge-in/cancel",
	},
	{
		key: "referenceEncode",
		symbol: "eliza_inference_encode_reference",
		requiredFor: "reference clone profile freezing",
	},
	{
		key: "referenceTokenFree",
		symbol: "eliza_inference_free_tokens",
		requiredFor: "reference clone profile freezing",
	},
];

function parseArgs(argv) {
	const date = new Date().toISOString().slice(0, 10);
	const args = {
		tier: process.env.ELIZA_VOICE_READINESS_TIER || "0_8b",
		bundle: process.env.ELIZA_VOICE_READINESS_BUNDLE || null,
		runtime: process.env.ELIZA_INFERENCE_LIBRARY || null,
		out: null,
		date,
		assert: true,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "--tier":
				args.tier = argv[++i];
				break;
			case "--bundle":
				args.bundle = argv[++i];
				break;
			case "--runtime":
				args.runtime = argv[++i];
				break;
			case "--out":
				args.out = argv[++i];
				break;
			case "--date":
				args.date = argv[++i];
				break;
			case "--no-assert":
				args.assert = false;
				break;
			case "-h":
			case "--help":
				printUsage();
				process.exit(0);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return args;
}

function printUsage() {
	console.log(
		[
			"Usage: node plugins/plugin-local-inference/native/verify/voice_profile_emotion_status.mjs [options]",
			"",
			"  --tier TIER       Eliza-1 tier slug, default 0_8b.",
			"  --bundle PATH     Installed bundle root.",
			"  --runtime PATH    libelizainference shared library.",
			"  --out PATH        Output JSON path.",
			"  --date YYYY-MM-DD Date segment for default output path.",
			"  --no-assert       Write report without fail-closed self assertions.",
			"",
		].join("\n"),
	);
}

function defaultBundleRoot(tier) {
	return resolve(
		process.env.HOME || "~",
		".eliza",
		"local-inference",
		"models",
		`eliza-1-${tier}.bundle`,
	);
}

function platformRuntimeDir() {
	if (process.platform === "darwin") return "darwin-arm64-metal-fused";
	if (process.platform === "linux") return "linux-x64-cuda";
	if (process.platform === "win32") return "windows-x64-vulkan";
	return `${process.platform}-${process.arch}`;
}

function runtimeFilenames() {
	if (process.platform === "darwin") return ["libelizainference.dylib"];
	if (process.platform === "win32") {
		return ["elizainference.dll", "libelizainference.dll"];
	}
	return ["libelizainference.so"];
}

function defaultRuntimePath(bundleRoot) {
	const candidates = [];
	for (const name of runtimeFilenames()) {
		candidates.push(
			resolve(
				process.env.HOME || "~",
				".eliza",
				"local-inference",
				"bin",
				"dflash",
				platformRuntimeDir(),
				name,
			),
		);
		candidates.push(resolve(bundleRoot, "lib", name));
	}
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function outputPath(args) {
	if (args.out) return resolve(args.out);
	const ymd = args.date.replaceAll("-", "");
	return resolve(
		reportsRoot,
		"local-e2e",
		args.date,
		`voice-profile-emotion-readiness-${args.tier}-${ymd}.json`,
	);
}

function displayPath(path) {
	if (!path) return path;
	const abs = resolve(path);
	const repoRel = relative(repoRoot, abs);
	if (!repoRel.startsWith("..")) return repoRel;
	return abs;
}

function resolveMaybeReportPath(path) {
	if (!path) return null;
	const abs = resolve(repoRoot, path);
	if (existsSync(abs)) return abs;
	if (path.startsWith("packages/inference/reports/")) {
		return resolve(
			reportsRoot,
			path.slice("packages/inference/reports/".length),
		);
	}
	return abs;
}

function loadJson(path) {
	const full = resolveMaybeReportPath(path);
	if (!full || !existsSync(full)) return null;
	return JSON.parse(readFileSync(full, "utf8"));
}

function sha256(path) {
	const full = resolveMaybeReportPath(path);
	if (!full || !existsSync(full)) return null;
	return createHash("sha256").update(readFileSync(full)).digest("hex");
}

function canonicalize(value) {
	if (value === undefined) return null;
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalize(value[key])]),
	);
}

function canonicalJson(value) {
	return JSON.stringify(canonicalize(value));
}

function normalizeWords(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
}

function wordErrorRate(reference, hypothesis) {
	const ref = normalizeWords(reference);
	const hyp = normalizeWords(hypothesis);
	if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
	const prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
	const curr = new Array(hyp.length + 1).fill(0);
	for (let i = 1; i <= ref.length; i += 1) {
		curr[0] = i;
		for (let j = 1; j <= hyp.length; j += 1) {
			const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j < curr.length; j += 1) prev[j] = curr[j];
	}
	return prev[hyp.length] / ref.length;
}

function readAscii(buf, offset, len) {
	return buf.toString("ascii", offset, offset + len);
}

function wavSize(path) {
	const full = resolveMaybeReportPath(path);
	if (!full || !existsSync(full)) return null;
	const buf = readFileSync(full);
	if (buf.length < 44 || readAscii(buf, 0, 4) !== "RIFF") return null;
	let fmtOffset = -1;
	let fmtSize = 0;
	let dataOffset = -1;
	let dataBytes = 0;
	for (let offset = 12; offset + 8 <= buf.length; ) {
		const id = readAscii(buf, offset, 4);
		const size = buf.readUInt32LE(offset + 4);
		const data = offset + 8;
		if (data + size > buf.length) return null;
		if (id === "fmt ") {
			fmtOffset = data;
			fmtSize = size;
		}
		if (id === "data") {
			dataOffset = data;
			dataBytes = size;
		}
		offset = data + size + (size % 2);
	}
	if (fmtOffset < 0 || dataOffset < 0 || fmtSize < 16) return null;
	const audioFormat = buf.readUInt16LE(fmtOffset);
	const channels = buf.readUInt16LE(fmtOffset + 2);
	const bitsPerSample = buf.readUInt16LE(fmtOffset + 14);
	const sampleRateHz = buf.readUInt32LE(fmtOffset + 4);
	const bytesPerFrame = channels * (bitsPerSample / 8);
	const samples = Math.floor(dataBytes / bytesPerFrame);
	let sumSq = 0;
	let peakAbs = 0;
	let silent = 0;
	let previousSign = 0;
	let zeroCrossings = 0;
	if (audioFormat === 1 && bitsPerSample === 16 && channels > 0) {
		for (let i = 0; i < samples; i += 1) {
			const value = buf.readInt16LE(dataOffset + i * bytesPerFrame) / 32768;
			const abs = Math.abs(value);
			peakAbs = Math.max(peakAbs, abs);
			sumSq += value * value;
			if (abs < 0.01) silent += 1;
			const sign = value > 0 ? 1 : value < 0 ? -1 : previousSign;
			if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
				zeroCrossings += 1;
			}
			if (sign !== 0) previousSign = sign;
		}
	}
	return {
		bytes: buf.length,
		sampleRateHz,
		channels,
		bitsPerSample,
		audioFormat,
		dataBytes,
		samples,
		durationMs: samples > 0 ? Math.round((samples / sampleRateHz) * 1000) : 0,
		rms: samples > 0 ? Number(Math.sqrt(sumSq / samples).toFixed(6)) : 0,
		peakAbs: Number(peakAbs.toFixed(6)),
		zeroCrossingRate:
			samples > 1 ? Number((zeroCrossings / (samples - 1)).toFixed(6)) : 0,
		silenceRatio: samples > 0 ? Number((silent / samples).toFixed(6)) : 1,
	};
}

export function inspectVoicePresetDefault(presetPath) {
	if (!existsSync(presetPath)) return { status: "missing", path: presetPath };
	const bytes = readFileSync(presetPath);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const summary = {
		status: "unreadable",
		path: presetPath,
		byteLength: bytes.length,
		sha256: digest,
	};
	if (bytes.length < 8) {
		return { ...summary, reason: "too short for ELZ1 header" };
	}
	const magic = bytes.readUInt32LE(0);
	const version = bytes.readUInt32LE(4);
	if (magic !== VOICE_PRESET_MAGIC) {
		return { ...summary, reason: "magic mismatch", magic, version };
	}
	if (
		(version !== VOICE_PRESET_VERSION_V1 && version !== VOICE_PRESET_VERSION_V2) ||
		bytes.length < VOICE_PRESET_HEADER_BYTES_V1
	) {
		return {
			...summary,
			status: "unreadable",
			magic,
			version,
			placeholderDetected: false,
			referenceCloneSeeded: false,
			reason: "unsupported or truncated ELZ1 preset",
		};
	}
	const sections =
		version === VOICE_PRESET_VERSION_V2 && bytes.length >= VOICE_PRESET_HEADER_BYTES_V2
			? {
					embedding: {
						offset: bytes.readUInt32LE(8),
						length: bytes.readUInt32LE(12),
					},
					phrases: {
						offset: bytes.readUInt32LE(16),
						length: bytes.readUInt32LE(20),
					},
					refAudioTokens: {
						offset: bytes.readUInt32LE(24),
						length: bytes.readUInt32LE(28),
					},
					refText: {
						offset: bytes.readUInt32LE(32),
						length: bytes.readUInt32LE(36),
					},
					instruct: {
						offset: bytes.readUInt32LE(40),
						length: bytes.readUInt32LE(44),
					},
					metadata: {
						offset: bytes.readUInt32LE(48),
						length: bytes.readUInt32LE(52),
					},
				}
			: {
					embedding: {
						offset: bytes.readUInt32LE(8),
						length: bytes.readUInt32LE(12),
					},
					phrases: {
						offset: bytes.readUInt32LE(16),
						length: bytes.readUInt32LE(20),
					},
					refAudioTokens: { offset: 0, length: 0 },
					refText: { offset: 0, length: 0 },
					instruct: { offset: 0, length: 0 },
					metadata: { offset: 0, length: 0 },
				};
	const embedding = sections.embedding.length
		? bytes.subarray(
				sections.embedding.offset,
				sections.embedding.offset + sections.embedding.length,
			)
		: Buffer.alloc(0);
	const embeddingAllZero =
		embedding.length > 0 && embedding.every((value) => value === 0);
	const placeholderDetected =
		bytes.length === SAMANTHA_PLACEHOLDER_BYTE_LENGTH &&
		embeddingAllZero &&
		sections.refAudioTokens.length === 0 &&
		sections.refText.length === 0 &&
		sections.instruct.length === 0;
	return {
		...summary,
		status: placeholderDetected ? "placeholder" : "present",
		magic,
		version,
		sections,
		embeddingSamples: sections.embedding.length / 4,
		embeddingAllZero,
		placeholderDetected,
		referenceCloneSeeded:
			sections.refAudioTokens.length > 8 && sections.refText.length > 0,
	};
}

function flattenManifestFiles(manifest) {
	const out = [];
	const files = manifest?.files ?? {};
	for (const [family, entries] of Object.entries(files)) {
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (entry?.path) out.push({ family, ...entry });
		}
	}
	return out;
}

function hasManifestPath(files, predicate) {
	return files.filter((entry) => predicate(String(entry.path ?? "")));
}

function inspectSymbols(runtimePath) {
	const result = {
		runtimePath,
		status: existsSync(runtimePath) ? "inspected" : "missing-runtime",
		symbols: [],
	};
	let nmText = "";
	if (existsSync(runtimePath)) {
		const attempts =
			process.platform === "darwin"
				? [
						["nm", ["-gU", runtimePath]],
						["nm", ["-g", runtimePath]],
					]
				: [
						["nm", ["-D", runtimePath]],
						["nm", ["-g", runtimePath]],
					];
		for (const [cmd, cmdArgs] of attempts) {
			try {
				nmText = execFileSync(cmd, cmdArgs, {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				break;
			} catch {
				nmText = "";
			}
		}
	}
	result.symbols = REQUIRED_RUNTIME_SYMBOLS.map((entry) => ({
		...entry,
		status: nmText.includes(entry.symbol) ? "present" : "missing",
	}));
	return result;
}

function missingBlocker(key, requiredFor, expected, blocker) {
	return { key, requiredFor, expected, blocker };
}

function inspectBundleAssets({ bundleRoot, tier, runtimePath }) {
	const manifestPath = resolve(bundleRoot, "eliza-1.manifest.json");
	const manifest = loadJson(manifestPath);
	const manifestFiles = flattenManifestFiles(manifest);
	const fileExists = (relPath) => existsSync(resolve(bundleRoot, relPath));
	const observedManifestPaths = manifestFiles.map((entry) => entry.path).sort();
	const observedDiskPaths = [];
	function recordIfExists(relPath) {
		if (fileExists(relPath)) observedDiskPaths.push(relPath);
	}
	for (const relPath of observedManifestPaths) recordIfExists(relPath);
	recordIfExists("cache/voice-preset-default.bin");
	recordIfExists("tts/omnivoice/samantha-ref.wav");

	const defaultPresetPath = resolve(bundleRoot, "cache", "voice-preset-default.bin");
	const defaultPreset = inspectVoicePresetDefault(defaultPresetPath);
	const runtimeSymbols = inspectSymbols(runtimePath);
	const symbolStatus = new Map(
		runtimeSymbols.symbols.map((entry) => [entry.key, entry.status]),
	);

	const ttsModel = hasManifestPath(
		manifestFiles,
		(p) => p === "tts/kokoro/model_q4.onnx" || /tts\/.*model.*\.onnx$/i.test(p),
	);
	const asrModel = hasManifestPath(manifestFiles, (p) => /asr\/.*\.gguf$/i.test(p));
	const asrBase = asrModel.filter((entry) => !/mmproj/i.test(entry.path));
	const asrMmproj = asrModel.filter((entry) => /mmproj/i.test(entry.path));
	const vad = hasManifestPath(
		manifestFiles,
		(p) => /vad\/.*(silero|vad).*\.(onnx|ggml\.bin|bin)$/i.test(p),
	);
	const emotion = hasManifestPath(manifestFiles, (p) =>
		/(emotion|wav2small|msp-dim).*\.(onnx|gguf|bin)$/i.test(p),
	);
	const speakerEncoder = hasManifestPath(manifestFiles, (p) =>
		/(wespeaker|speaker.*encoder|speaker-id).*\.(onnx|gguf|bin)$/i.test(p),
	);
	const diarizer = hasManifestPath(manifestFiles, (p) =>
		/(pyannote|diar|segmentation).*\.(onnx|gguf|bin)$/i.test(p),
	);

	const requirements = [
		{
			key: "ttsModel",
			status: ttsModel.some((entry) => fileExists(entry.path)) ? "present" : "missing",
			expected: "tts/kokoro/model_q4.onnx",
			found: ttsModel.map((entry) => entry.path),
			requiredFor: "local TTS",
		},
		{
			key: "asrModel",
			status:
				asrBase.some((entry) => fileExists(entry.path)) &&
				asrMmproj.some((entry) => fileExists(entry.path))
					? "present"
					: "missing",
			expected: "asr/eliza-1-asr.gguf plus asr/eliza-1-asr-mmproj.gguf",
			found: asrModel.map((entry) => entry.path),
			requiredFor: "local ASR",
		},
		{
			key: "sileroVad",
			status: vad.some((entry) => fileExists(entry.path)) ? "present" : "missing",
			expected: "vad/silero-vad-int8.onnx or vad/silero-vad-v5.1.2.ggml.bin",
			found: vad.map((entry) => entry.path),
			requiredFor: "local VAD and barge-in gating",
		},
		{
			key: "defaultVoicePreset",
			status: defaultPreset.status === "missing" ? "missing" : defaultPreset.status,
			expected: "cache/voice-preset-default.bin",
			found: defaultPreset.status === "missing" ? [] : ["cache/voice-preset-default.bin"],
			requiredFor: "default voice profile seed",
			note:
				"Presence proves only a seeded default preset exists; reference cloning still requires encode_reference/free_tokens and an ASR round trip.",
			blocker:
				defaultPreset.placeholderDetected === true
					? `cache/voice-preset-default.bin is the ${defaultPreset.byteLength}-byte zero-fill Samantha placeholder; af_same is not product-ready until the preset is regenerated.`
					: undefined,
			preset: {
				byteLength: defaultPreset.byteLength ?? null,
				sha256: defaultPreset.sha256 ?? null,
				placeholderDetected: defaultPreset.placeholderDetected === true,
				referenceCloneSeeded: defaultPreset.referenceCloneSeeded === true,
			},
		},
		{
			key: "samanthaReferenceWav",
			status: fileExists("tts/omnivoice/samantha-ref.wav") ? "present" : "missing",
			expected: "tts/omnivoice/samantha-ref.wav",
			found: fileExists("tts/omnivoice/samantha-ref.wav")
				? ["tts/omnivoice/samantha-ref.wav"]
				: [],
			requiredFor: "runtime regeneration of the Samantha reference preset",
			blocker:
				defaultPreset.placeholderDetected === true &&
				!fileExists("tts/omnivoice/samantha-ref.wav")
					? `The ${tier} bundle default preset is a zero-fill Samantha placeholder, but tts/omnivoice/samantha-ref.wav is not staged for deterministic regeneration.`
					: undefined,
		},
		{
			key: "nativeEmotionAcousticModel",
			status: emotion.some((entry) => fileExists(entry.path)) ? "present" : "missing",
			expected:
				"wav2small-msp-dim-int8 ONNX artifact, normally a manifest files.emotion entry such as voice/emotion/wav2small-msp-dim-int8.onnx",
			found: emotion.map((entry) => entry.path),
			requiredFor: "model-native acoustic emotion attribution",
			blocker:
				emotion.length === 0
					? `No wav2small-msp-dim-int8 ONNX artifact or manifest files.emotion entry is present in the ${tier} bundle.`
					: undefined,
		},
		{
			key: "speakerEncoderModel",
			status: speakerEncoder.some((entry) => fileExists(entry.path))
				? "present"
				: "missing",
			expected: "wespeaker-resnet34-lm-int8 ONNX artifact for 256-dim speaker embeddings",
			found: speakerEncoder.map((entry) => entry.path),
			requiredFor: "sample-derived speaker embeddings and entity attribution from audio",
			blocker:
				speakerEncoder.length === 0
					? `No WeSpeaker ResNet34-LM ONNX artifact is present in the ${tier} bundle.`
					: undefined,
		},
		{
			key: "pyannoteDiarizerModel",
			status: diarizer.some((entry) => fileExists(entry.path)) ? "present" : "missing",
			expected: "pyannote-segmentation-3.0-int8 ONNX artifact for local multi-speaker segmentation",
			found: diarizer.map((entry) => entry.path),
			requiredFor: "local diarization DER",
			blocker:
				diarizer.length === 0
					? `No pyannote-segmentation-3.0 ONNX artifact is present in the ${tier} bundle.`
					: undefined,
		},
	];

	const missingNativeFeatureBlockers = requirements
		.filter((req) => req.status !== "present" && req.blocker)
		.map((req) =>
			missingBlocker(req.key, req.requiredFor, req.expected, req.blocker),
		);
	if (
		symbolStatus.get("referenceEncode") !== "present" ||
		symbolStatus.get("referenceTokenFree") !== "present"
	) {
		missingNativeFeatureBlockers.push(
			missingBlocker(
				"referenceCloneEncodeAbi",
				"reference clone profile freezing",
				"libelizainference exports eliza_inference_encode_reference and eliza_inference_free_tokens",
				"The active libelizainference runtime does not export the optional reference-clone encode/free-token symbols.",
			),
		);
	}

	const coreRequirements = requirements.filter((req) =>
		["ttsModel", "asrModel", "sileroVad", "defaultVoicePreset"].includes(
			req.key,
		),
	);
	const coreMissing = coreRequirements.some((req) => req.status === "missing");
	const coreReady = coreRequirements.every((req) => req.status === "present");
	const nativeFeatureReady = missingNativeFeatureBlockers.length === 0;

	return {
		bundleDir: bundleRoot,
		manifestPath,
		status: coreMissing
			? "core_voice_assets_missing"
			: !coreReady
				? "core_voice_assets_blocked"
			: nativeFeatureReady
				? "ready"
				: "partial_runtime_ready_native_features_fail_closed",
		requirements,
		defaultVoicePreset: defaultPreset,
		runtimeSymbols,
		missingNativeFeatureBlockers,
		relevantObservedFiles: Array.from(
			new Set([...observedDiskPaths, ...observedManifestPaths]),
		).sort(),
		conclusion: nativeFeatureReady
			? `${tier} has the required local voice profile and emotion assets.`
			: `${tier} has local TTS/ASR/VAD surfaces, but model-native emotion, full DER diarization, or reference-clone profile freezing remain fail-closed when their exact model artifacts or native symbols are missing.`,
	};
}

function deterministicVoiceProfileStatus({ wavPath, referenceText, label }) {
	const wav = wavSize(wavPath);
	const wavSha256 = sha256(wavPath);
	if (!wav || !wavSha256) {
		return { status: "missing", wavPath };
	}
	const issues = [];
	if (wav.bitsPerSample !== 16) issues.push("sample is not PCM16");
	if (wav.sampleRateHz < 16000) issues.push("sample rate below 16kHz");
	if (wav.durationMs < 1000) issues.push("duration below 1000ms");
	if (wav.rms <= 0.001) issues.push("sample appears silent");
	if (!referenceText || referenceText.trim().split(/\s+/).length < 3) {
		issues.push("reference text is missing or too short");
	}
	const payload = {
		schemaVersion: "eliza.voice_profile.v1",
		embeddingModel: "eliza-voice-profile-features-v1",
		reference: {
			label,
			referenceText,
			consent: { attribution: true, synthesis: false },
		},
		samples: [
			{
				id: "reference-sample",
				wavSha256,
				audio: wav,
			},
		],
	};
	const artifactId = `vpa_${createHash("sha256")
		.update(canonicalJson(payload))
		.digest("hex")
		.slice(0, 32)}`;
	return {
		status: issues.length === 0 ? "ready" : "needs_review",
		artifactId,
		deterministic: true,
		wavPath,
		wavSha256,
		referenceText,
		audio: wav,
		attributionStatus: issues.length === 0 ? "ready" : "needs_review",
		synthesisStatus: "not_authorized",
		issues,
	};
}

function heuristicEmotionAttribution({ transcript, audio }) {
	const text = String(transcript ?? "").toLowerCase();
	const scores = {
		happy: 0,
		sad: 0,
		angry: 0,
		nervous: 0,
		calm: 0,
		excited: 0,
		whisper: 0,
	};
	const evidence = [];
	const add = (emotion, amount, detail) => {
		scores[emotion] = Math.min(1, scores[emotion] + amount);
		evidence.push({ source: "text_audio_heuristic", emotion, detail, amount });
	};
	if (/\b(happy|glad|great|thanks|love)\b/.test(text)) {
		add("happy", 0.32, "positive transcript terms");
	}
	if (/\b(excited|amazing|wow|urgent)\b/.test(text)) {
		add("excited", 0.34, "high-arousal transcript terms");
	}
	if (/\b(sad|sorry|tired|hurt|miss)\b/.test(text)) {
		add("sad", 0.34, "sadness transcript terms");
	}
	if (/\b(angry|mad|furious|stop|unacceptable)\b/.test(text)) {
		add("angry", 0.36, "anger transcript terms");
	}
	if (/\b(worried|nervous|afraid|scared|anxious|maybe)\b/.test(text)) {
		add("nervous", 0.34, "anxiety transcript terms");
	}
	if (audio?.rms >= 0.18 && /!|urgent|wow/.test(text)) {
		add("excited", 0.2, "high energy audio with arousal text");
	}
	if (audio?.rms <= 0.06 && audio?.zeroCrossingRate >= 0.14) {
		add("whisper", 0.3, "low energy, high zero-crossing audio");
	}
	if (audio?.rms <= 0.1) add("calm", 0.12, "restrained energy audio");
	const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
	return {
		status: "available",
		emotion: best?.[1] >= 0.18 ? best[0] : null,
		confidence: best?.[1] ?? 0,
		modelNativeEmotion: false,
		conclusion:
			"Emotion is attributed from transcript text and audio features only; the local ASR smoke output is not treated as model-native emotion recognition.",
		evidence,
		scores,
	};
}

export function detectAsrNativeEmotionEvidence(report) {
	const candidates = [
		report?.emotionLabel,
		report?.emotion,
		report?.asr?.emotionLabel,
		report?.asr?.emotion,
		report?.metadata?.emotionLabel,
		report?.metadata?.emotion,
	].filter((value) => typeof value === "string" && value.trim().length > 0);
	const vadPayload =
		report?.emotionVad ??
		report?.vadEmotion ??
		report?.asr?.emotionVad ??
		report?.metadata?.emotionVad ??
		null;
	const hasVadPayload =
		Array.isArray(vadPayload) && vadPayload.length >= 3
			? vadPayload.every((value) => Number.isFinite(Number(value)))
			: vadPayload !== null &&
				typeof vadPayload === "object" &&
				["valence", "arousal", "dominance"].every((key) =>
					Number.isFinite(Number(vadPayload[key])),
				);
	const supported =
		report?.emotionLabelSupported === true ||
		report?.asr?.emotionLabelSupported === true ||
		report?.metadata?.emotionLabelSupported === true ||
		report?.emotionVadSupported === true ||
		report?.asr?.emotionVadSupported === true;
	return {
		status: supported && (candidates.length > 0 || hasVadPayload) ? "present" : "absent",
		emotionLabelSupported: supported,
		emotionLabels: candidates,
		hasVadPayload,
		modelNativeEmotionClaimed:
			supported && (candidates.length > 0 || hasVadPayload),
	};
}

function asrSummary(path) {
	const j = loadJson(path);
	if (!j) return { status: "missing", path };
	const expected =
		j.normalizedExpected ??
		j.expectedContains ??
		j.expected ??
		j.referenceText ??
		null;
	const transcript = j.transcript ?? j.normalizedTranscript ?? "";
	const wer =
		expected && transcript
			? Number(wordErrorRate(expected, transcript).toFixed(4))
			: null;
	return {
		status: j.ok ? "pass" : "fail",
		path,
		ok: j.ok === true,
		bundle: j.bundle ?? null,
		wav: j.wav ?? null,
		transcript: j.transcript,
		normalizedTranscript: j.normalizedTranscript,
		expected,
		wer,
		transcribeMs: j.transcribeMs,
		totalMs: j.totalMs,
		nativeEmotion: detectAsrNativeEmotionEvidence(j),
	};
}

function asrFromTtsSmokeSummary(path) {
	const j = loadJson(path);
	if (!j) return { status: "missing", path };
	const expected = j.normalizedExpected ?? j.expectedContains ?? j.expected ?? null;
	const transcript = j.normalizedTranscript ?? j.transcript ?? "";
	const wav = j.wav ? wavSize(j.wav) : null;
	const wer =
		expected && transcript
			? Number(wordErrorRate(expected, transcript).toFixed(4))
			: null;
	const lexicalPass =
		j.ok === true &&
		typeof expected === "string" &&
		expected.length > 0 &&
		typeof transcript === "string" &&
		(wer === 0 || transcript.includes(expected));
	return {
		status: lexicalPass && wav ? "pass" : "fail",
		path,
		ok: j.ok === true,
		bundle: j.bundle ?? null,
		wav: j.wav ?? null,
		wavInfo: wav,
		transcript: j.transcript ?? null,
		normalizedTranscript: j.normalizedTranscript ?? null,
		expected,
		wer,
		transcribeMs: j.transcribeMs ?? null,
		totalMs: j.totalMs ?? null,
		nativeEmotion: detectAsrNativeEmotionEvidence(j),
		reason:
			lexicalPass && wav
				? "active bundle generated TTS audio round-tripped through local ASR"
				: j.ok === true
					? "ASR-from-TTS smoke did not meet lexical validation"
					: "ASR-from-TTS smoke report ok=false",
	};
}

function ttsSummary(path) {
	const j = loadJson(path);
	if (!j) return { status: "missing", path };
	return {
		status: j.ok ? "pass" : "fail",
		path,
		text: j.text,
		backend: j.backend ?? null,
		voiceId: j.voiceId ?? j.speakerPresetId ?? null,
		streamSupported: j.streamSupported,
		maskgitSteps: j.maskgitSteps,
		chunks: j.chunks,
		bodyChunks: j.bodyChunks,
		samples: j.samples,
		audioSeconds: j.audioSeconds,
		synthMs: j.synthMs,
		rtf: j.rtf,
		modelPath: j.modelPath ?? null,
		wavOut: j.wavOut,
		wavSha256: j.wavOut ? sha256(j.wavOut) : null,
	};
}

function walkJsonReports(root, maxDepth = 6) {
	const out = [];
	function walk(dir, depth) {
		if (depth > maxDepth || !existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith(".json")) {
				let data = null;
				try {
					data = JSON.parse(readFileSync(full, "utf8"));
				} catch {
					data = null;
				}
				out.push({
					path: full,
					name: entry.name,
					mtimeMs: statSync(full).mtimeMs,
					data,
				});
			}
		}
	}
	walk(root, 0);
	return out;
}

function matchesTier(data, name, tier) {
	const haystack = [
		name,
		data?.tier,
		data?.bundle?.tier,
		data?.bundle,
		data?.modelId,
		data?.label,
		data?.runId,
	]
		.filter(Boolean)
		.join(" ");
	return haystack.includes(tier) || haystack.includes(`eliza-1-${tier}.bundle`);
}

function newestJsonReportWhere(roots, predicate) {
	const candidates = roots
		.flatMap((root) => walkJsonReports(root))
		.filter(({ data }) => data !== null)
		.filter((entry) => predicate(entry))
		.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
	return candidates[0] ?? null;
}

function reportPath(entry) {
	return entry ? displayPath(entry.path) : null;
}

function buildDefaultStreamingTtsRoundTrip({ tier }) {
	const localE2e = resolve(reportsRoot, "local-e2e");
	const defaultTtsEntry = newestJsonReportWhere([localE2e], ({ name, data }) => {
		const lower = name.toLowerCase();
		return (
			(lower.startsWith("tts-kokoro-smoke") ||
				lower.startsWith("tts-stream-smoke")) &&
			data?.ok === true &&
			matchesTier(data, name, tier)
		);
	});
	const defaultTts = ttsSummary(reportPath(defaultTtsEntry));
	const defaultAsrEntry =
		defaultTts.wavOut
			? newestJsonReportWhere([localE2e], ({ name, data }) => {
					const lower = name.toLowerCase();
					return (
						(lower.startsWith("asr-tts-kokoro-loopback") ||
							lower.startsWith("asr-tts-loopback")) &&
						data?.wav === defaultTts.wavOut &&
						matchesTier(data, name, tier)
					);
				})
			: null;
	const latestAsrEntry = newestJsonReportWhere([localE2e], ({ name, data }) => {
		const lower = name.toLowerCase();
		return (
			(lower.startsWith("asr-tts-kokoro-loopback") ||
				lower.startsWith("asr-tts-loopback")) &&
			matchesTier(data, name, tier)
		);
	});
	const compatibleAsrEntry = newestJsonReportWhere([localE2e], ({ name, data }) => {
		const lower = name.toLowerCase();
		return (
			(lower.startsWith("asr-tts-kokoro-loopback") ||
				lower.startsWith("asr-tts-loopback")) &&
			data?.ok === true &&
			matchesTier(data, name, tier)
		);
	});
	const defaultAsr = asrFromTtsSmokeSummary(
		reportPath(defaultAsrEntry ?? latestAsrEntry),
	);
	const compatibleExistingTtsLoopback = asrFromTtsSmokeSummary(
		reportPath(compatibleAsrEntry),
	);
	const directPass = defaultTts.status === "pass" && defaultAsr.status === "pass";
	const status = directPass
		? "pass"
		: compatibleExistingTtsLoopback.status === "pass"
			? "fail_default_kokoro_asr_loopback"
			: "fail";

	return {
		status,
		evidenceMode: directPass
			? "default_tts_asr_loopback"
			: compatibleExistingTtsLoopback.status === "pass"
				? "compatible_existing_tts_loopback_only"
				: "missing_or_failed",
		productReady: directPass,
		tts: defaultTts,
		asr: defaultAsr,
		compatibleExistingTtsLoopback,
		compatibleExistingTtsLoopbackProductReady: false,
		compatibleExistingTtsLoopbackReason:
			"A passing ASR-from-TTS report proves the ASR path can preserve lexical content for some local generated audio, but it does not override a failed loopback on the current default Kokoro TTS output.",
	};
}

function buildStyleInstructionRoundTrips() {
	const paths = {
		styled6TtsPath:
			"plugins/plugin-local-inference/native/reports/local-e2e/2026-05-12/tts-stream-smoke-styled-meeting-steps6-20260512.json",
		styled6AsrPath:
			"plugins/plugin-local-inference/native/reports/local-e2e/2026-05-12/asr-ffi-smoke-tts-stream-styled-meeting-steps6-20260512.json",
		styled32TtsPath:
			"plugins/plugin-local-inference/native/reports/local-e2e/2026-05-12/tts-stream-smoke-styled-meeting-steps32-20260512.json",
		styled32AsrPath:
			"plugins/plugin-local-inference/native/reports/local-e2e/2026-05-12/asr-ffi-smoke-tts-stream-styled-meeting-steps32-20260512.json",
	};
	const sixAsr = asrSummary(paths.styled6AsrPath);
	const thirtyTwoAsr = asrSummary(paths.styled32AsrPath);
	return {
		status: sixAsr.status === "pass" || thirtyTwoAsr.status === "pass" ? "pass" : "fail",
		conclusion:
			"The native instruct surface is only product-ready when style-conditioned outputs preserve lexical content under the same ASR gate as default TTS.",
		voiceDesignVocabulary:
			"Local omnivoice voice-design accepts gender, age, pitch, accent, and whisper. It does not expose discrete emotion labels in the fused VoiceDesign table.",
		sixStep: {
			tts: ttsSummary(paths.styled6TtsPath),
			asr: sixAsr,
		},
		thirtyTwoStep: {
			tts: ttsSummary(paths.styled32TtsPath),
			asr: thirtyTwoAsr,
		},
	};
}

export function deriveReferenceVoiceProfileProductStatus({
	profileStatus,
	nativeReferenceClonePass,
}) {
	if (profileStatus === "ready" && nativeReferenceClonePass) return "ready";
	if (profileStatus === "ready") return "attribution_ready_synthesis_not_ready";
	return profileStatus;
}

function buildReferenceVoiceProfileProbe({ readiness, defaultRoundTrip }) {
	const referenceWav =
		defaultRoundTrip.compatibleExistingTtsLoopback?.wav ??
		defaultRoundTrip.tts?.wavOut ??
		null;
	const profileArtifact = deterministicVoiceProfileStatus({
		wavPath: referenceWav,
		referenceText: DEFAULT_REFERENCE_TEXT,
		label: "local-reference",
	});
	const refCloneWavPath =
		"plugins/plugin-local-inference/native/reports/local-e2e/2026-05-12/audio/tts-refclone-meeting-steps32-20260512.wav";
	const refCloneAsrPath =
		"plugins/plugin-local-inference/native/reports/local-e2e/2026-05-12/asr-ffi-smoke-tts-refclone-meeting-steps32-20260512.json";
	const referenceBlockers = readiness.missingNativeFeatureBlockers.filter(
		(blocker) => blocker.key === "referenceCloneEncodeAbi",
	);
	const nativeReferenceClonePass =
		referenceBlockers.length === 0 && asrSummary(refCloneAsrPath).status === "pass";
	return {
		status: deriveReferenceVoiceProfileProductStatus({
			profileStatus: profileArtifact.status,
			nativeReferenceClonePass,
		}),
		conclusion:
			"Sample WAV + reference metadata can produce a deterministic attribution profile artifact for speaker attribution. It is not a product-ready reference-clone synthesis profile until native ref_audio/ref_text round-trips pass the lexical gate.",
		profileArtifact,
		referenceWav,
		referenceSha256: referenceWav ? sha256(referenceWav) : null,
		nativeReferenceCloneRoundTrip: {
			status: nativeReferenceClonePass ? "pass" : "fail",
			nativeBlockers: referenceBlockers,
			outputWav: refCloneWavPath,
			outputWavInfo: wavSize(refCloneWavPath),
			outputSha256: sha256(refCloneWavPath),
			asr: asrSummary(refCloneAsrPath),
		},
	};
}

export function deriveNativeEmotionStatus({
	nativeEmotionModelPresent,
	asrEmotionEvidence,
}) {
	if (nativeEmotionModelPresent && asrEmotionEvidence?.modelNativeEmotionClaimed) {
		return "implemented";
	}
	return "not_implemented";
}

function buildEmotionAwareAsrAssessment({ readiness, defaultRoundTrip }) {
	const nativeEmotionRequirement = readiness.requirements.find(
		(req) => req.key === "nativeEmotionAcousticModel",
	);
	const nativeEmotionModelPresent = nativeEmotionRequirement?.status === "present";
	const asrEmotionEvidence =
		defaultRoundTrip.asr?.nativeEmotion?.modelNativeEmotionClaimed
			? defaultRoundTrip.asr.nativeEmotion
			: defaultRoundTrip.compatibleExistingTtsLoopback?.nativeEmotion;
	const nativeStatus = deriveNativeEmotionStatus({
		nativeEmotionModelPresent,
		asrEmotionEvidence,
	});
	const nativeBlockers = [];
	if (!nativeEmotionModelPresent && nativeEmotionRequirement?.blocker) {
		nativeBlockers.push(
			missingBlocker(
				nativeEmotionRequirement.key,
				nativeEmotionRequirement.requiredFor,
				nativeEmotionRequirement.expected,
				nativeEmotionRequirement.blocker,
			),
		);
	}
	if (!asrEmotionEvidence?.modelNativeEmotionClaimed) {
		nativeBlockers.push(
			missingBlocker(
				"asrEmotionContract",
				"model-native emotion-aware ASR",
				"ASR smoke report carries emotionLabelSupported=true plus an emotion label or V-A-D payload",
				"Current local ASR smoke evidence returns transcript fields only; no supported emotion field is present.",
			),
		);
	}
	const transcript =
		defaultRoundTrip.asr?.transcript ??
		defaultRoundTrip.asr?.normalizedTranscript ??
		defaultRoundTrip.compatibleExistingTtsLoopback?.transcript ??
		defaultRoundTrip.tts?.text ??
		"";
	const audio = wavSize(
		defaultRoundTrip.asr?.wav ??
			defaultRoundTrip.compatibleExistingTtsLoopback?.wav ??
			defaultRoundTrip.tts?.wavOut,
	);
	return {
		status:
			nativeStatus === "implemented"
				? "native_emotion_ready"
				: "heuristic_available_native_not_implemented",
		conclusion:
			"Emotion status is heuristic attribution from ASR transcript text and audio features unless ASR evidence explicitly advertises model-native emotion labels or V-A-D output.",
		currentLocalAsrEvidence:
			asrEmotionEvidence?.modelNativeEmotionClaimed
				? "Local ASR smoke evidence carries a supported native emotion payload."
				: "The local ASR FFI returns transcript fields; no supported emotion field is present in the smoke evidence.",
		asrNativeEmotion: {
			status: nativeStatus,
			modelNativeEmotionClaimed: nativeStatus === "implemented",
			nativeBlockers,
			evidence: asrEmotionEvidence ?? null,
			requiredEvidence:
				"ASR output must carry a supported emotion label or V-A-D payload and set emotionLabelSupported=true before this can be reported as model-native emotion-aware ASR.",
		},
		defaultRoundTripAttribution: heuristicEmotionAttribution({
			transcript,
			audio,
		}),
	};
}

function newestOptionalEvidence({ tier }) {
	const vad = newestJsonReportWhere([resolve(reportsRoot, "vad")], ({ name, data }) =>
		name.toLowerCase().includes("vad-quality") && matchesTier(data, name, tier),
	);
	const diarization = newestJsonReportWhere(
		[verifyReportsRoot],
		({ name, data }) =>
			name.toLowerCase().includes("diarization") && matchesTier(data, name, tier),
	);
	return {
		vadQuality: vad
			? { source: reportPath(vad), summary: vad.data?.summary ?? vad.data ?? null }
			: { source: null, summary: null },
		speakerAttributionAndDiarization: diarization
			? { source: reportPath(diarization), report: diarization.data }
			: { source: null, report: null },
	};
}

export function assertFailClosedReport(report) {
	const failures = [];
	if (
		report.defaultStreamingTtsRoundTrip?.productReady === true &&
		(report.defaultStreamingTtsRoundTrip?.tts?.status !== "pass" ||
			report.defaultStreamingTtsRoundTrip?.asr?.status !== "pass")
	) {
		failures.push("default voice productReady=true without paired TTS+ASR pass");
	}
	if (
		report.referenceVoiceProfileProbe?.status === "ready" &&
		report.referenceVoiceProfileProbe?.nativeReferenceCloneRoundTrip?.status !== "pass"
	) {
		failures.push("reference voice profile marked ready without reference-clone round trip pass");
	}
	if (
		report.referenceVoiceProfileProbe?.status === "ready" &&
		report.referenceVoiceProfileProbe?.nativeReferenceCloneRoundTrip?.nativeBlockers?.length > 0
	) {
		failures.push("reference voice profile marked ready while native blockers remain");
	}
	const nativeEmotion = report.emotionAwareAsrAssessment?.asrNativeEmotion;
	if (
		nativeEmotion?.modelNativeEmotionClaimed === true &&
		nativeEmotion?.status !== "implemented"
	) {
		failures.push("model-native emotion claimed without implemented status");
	}
	if (
		report.emotionAwareAsrAssessment?.status === "native_emotion_ready" &&
		nativeEmotion?.nativeBlockers?.length > 0
	) {
		failures.push("emotion-aware ASR marked ready while native blockers remain");
	}
	if (failures.length > 0) {
		const err = new Error(`voice readiness fail-closed assertion failed: ${failures.join("; ")}`);
		err.failures = failures;
		throw err;
	}
	return {
		status: "pass",
		checks: [
			"default product readiness requires paired current TTS+ASR pass",
			"reference clone readiness requires native ABI plus ASR round trip",
			"model-native emotion requires explicit supported ASR emotion payload",
		],
	};
}

export function buildVoiceProfileEmotionReport(opts) {
	const tier = opts.tier;
	const bundleRoot = resolve(opts.bundle || defaultBundleRoot(tier));
	const runtimePath = resolve(opts.runtime || defaultRuntimePath(bundleRoot));
	const readiness = inspectBundleAssets({ bundleRoot, tier, runtimePath });
	const defaultRoundTrip = buildDefaultStreamingTtsRoundTrip({ tier });
	const styleInstructionRoundTrips = buildStyleInstructionRoundTrips();
	const referenceVoiceProfileProbe = buildReferenceVoiceProfileProbe({
		readiness,
		defaultRoundTrip,
	});
	const emotionAwareAsrAssessment = buildEmotionAwareAsrAssessment({
		readiness,
		defaultRoundTrip,
	});
	const optionalEvidence = newestOptionalEvidence({ tier });
	const report = {
		generatedAt: new Date().toISOString(),
		tier,
		bundle: {
			tier,
			dir: bundleRoot,
		},
		runtime: runtimePath,
		nativeVoiceCapabilityReadiness: readiness,
		defaultStreamingTtsRoundTrip: defaultRoundTrip,
		styleInstructionRoundTrips,
		referenceVoiceProfileProbe,
		emotionAwareAsrAssessment,
		optionalEvidence,
		nextEngineeringGate:
			"Do not ship style-conditioned or reference-clone voice profiles as recommended defaults until their ASR round trips pass the same WER gate as default streaming TTS. Expose native ref_audio/ref_text through libelizainference and add a supported ASR emotion payload before productizing sample-derived profile synthesis or model-native emotion-aware ASR.",
	};
	report.selfChecks = assertFailClosedReport(report);
	return report;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const report = buildVoiceProfileEmotionReport(args);
	if (args.assert) {
		report.selfChecks = assertFailClosedReport(report);
	}
	const out = outputPath(args);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		JSON.stringify(
			{
				ok: true,
				out: displayPath(out),
				defaultTtsStatus: report.defaultStreamingTtsRoundTrip.status,
				defaultTtsProductReady:
					report.defaultStreamingTtsRoundTrip.productReady,
				referenceVoiceProfileStatus: report.referenceVoiceProfileProbe.status,
				emotionAwareAsrStatus: report.emotionAwareAsrAssessment.status,
				modelNativeEmotionClaimed:
					report.emotionAwareAsrAssessment.asrNativeEmotion
						.modelNativeEmotionClaimed,
				blockers:
					report.nativeVoiceCapabilityReadiness.missingNativeFeatureBlockers,
			},
			null,
			2,
		),
	);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (err) {
		console.error(err?.stack ?? String(err));
		process.exit(1);
	}
}
