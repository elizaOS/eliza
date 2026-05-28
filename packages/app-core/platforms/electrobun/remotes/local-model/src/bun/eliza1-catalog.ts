import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ELIZA_1_HF_REPO,
	type Eliza1BundleTier,
	type Eliza1VoiceComponent,
	type LocalModelCapability,
	type LocalModelCatalogEntry,
	type LocalModelRole,
} from "./protocol.ts";

type TierSnapshot = {
	tier: string;
	params: string;
	displayName: string;
	sizeGb?: number;
	minRamGb?: number;
	contextLength?: number;
	activeTier: boolean;
	defaultTier?: boolean;
	roles: LocalModelRole[];
	capabilities: LocalModelCapability[];
	source?: Record<string, unknown>;
};

const LOCAL_CATALOG_PATH = resolveLocalCatalogPath();

const TIER_SNAPSHOTS: TierSnapshot[] = [
	{
		tier: "0_6b",
		params: "0.6B",
		displayName: "Eliza-1 0.6B",
		activeTier: false,
		roles: ["chat"],
		capabilities: ["text-generation"],
	},
	{
		tier: "0_8b",
		params: "0.8B",
		displayName: "Eliza-1 0.8B",
		sizeGb: 0.5,
		minRamGb: 2,
		contextLength: 131072,
		activeTier: true,
		roles: ["chat", "voice", "tts", "stt", "vad", "vision", "image"],
		capabilities: [
			"text-generation",
			"mtp",
			"text-to-speech",
			"speech-to-text",
			"voice-activity-detection",
			"vision",
			"image-generation",
		],
	},
	{
		tier: "1_7b",
		params: "1.7B",
		displayName: "Eliza-1 1.7B",
		activeTier: false,
		roles: ["chat"],
		capabilities: ["text-generation"],
	},
	{
		tier: "2b",
		params: "2B",
		displayName: "Eliza-1 2B",
		sizeGb: 1.4,
		minRamGb: 4,
		contextLength: 131072,
		activeTier: true,
		defaultTier: true,
		roles: ["chat", "voice", "tts", "stt", "vad", "vision", "image"],
		capabilities: [
			"text-generation",
			"mtp",
			"text-to-speech",
			"speech-to-text",
			"voice-activity-detection",
			"vision",
			"image-generation",
		],
	},
	{
		tier: "4b",
		params: "4B",
		displayName: "Eliza-1 4B",
		sizeGb: 2.6,
		minRamGb: 10,
		contextLength: 131072,
		activeTier: true,
		roles: [
			"chat",
			"embedding",
			"voice",
			"tts",
			"stt",
			"vad",
			"vision",
			"image",
		],
		capabilities: [
			"text-generation",
			"text-embedding",
			"mtp",
			"text-to-speech",
			"speech-to-text",
			"voice-activity-detection",
			"vision",
			"image-generation",
		],
	},
	{
		tier: "9b",
		params: "9B",
		displayName: "Eliza-1 9B",
		sizeGb: 5.4,
		minRamGb: 12,
		contextLength: 131072,
		activeTier: true,
		roles: [
			"chat",
			"embedding",
			"voice",
			"tts",
			"stt",
			"vad",
			"vision",
			"image",
		],
		capabilities: [
			"text-generation",
			"text-embedding",
			"mtp",
			"text-to-speech",
			"speech-to-text",
			"voice-activity-detection",
			"vision",
			"image-generation",
		],
	},
	{
		tier: "27b",
		params: "27B",
		displayName: "Eliza-1 27B",
		sizeGb: 16.8,
		minRamGb: 32,
		contextLength: 131072,
		activeTier: true,
		roles: [
			"chat",
			"embedding",
			"voice",
			"tts",
			"stt",
			"vad",
			"vision",
			"image",
		],
		capabilities: [
			"text-generation",
			"text-embedding",
			"mtp",
			"text-to-speech",
			"speech-to-text",
			"voice-activity-detection",
			"vision",
			"image-generation",
		],
	},
	{
		tier: "27b-256k",
		params: "27B",
		displayName: "Eliza-1 27B 256k",
		sizeGb: 16.8,
		minRamGb: 48,
		contextLength: 262144,
		activeTier: true,
		roles: [
			"chat",
			"embedding",
			"voice",
			"tts",
			"stt",
			"vad",
			"vision",
			"image",
		],
		capabilities: [
			"text-generation",
			"text-embedding",
			"mtp",
			"text-to-speech",
			"speech-to-text",
			"voice-activity-detection",
			"vision",
			"image-generation",
		],
	},
];

const VOICE_COMPONENTS: Eliza1VoiceComponent[] = [
	{
		id: "omnivoice",
		path: "voice/omnivoice",
		displayName: "OmniVoice",
		roles: ["tts", "voice"],
		capabilities: ["text-to-speech"],
		files: [
			"omnivoice-base-q4_k_m.gguf",
			"omnivoice-base-q8_0.gguf",
			"omnivoice-tokenizer-q4_k_m.gguf",
		],
	},
	{
		id: "emotion",
		path: "voice/emotion",
		displayName: "Emotion classifier",
		roles: ["emotion", "voice"],
		capabilities: ["emotion-classification"],
		files: ["wav2small-cls7-int8.onnx"],
	},
	{
		id: "turn",
		path: "voice/turn",
		displayName: "Turn detector",
		roles: ["turn", "voice"],
		capabilities: ["turn-detection"],
		files: ["intl/turn-detector-intl-q8.gguf", "intl/model_q8.onnx"],
	},
	{
		id: "asr",
		path: "voice/asr",
		displayName: "ASR",
		roles: ["stt", "voice"],
		capabilities: ["speech-to-text"],
		files: ["eliza-1-asr-q8_0.gguf", "eliza-1-asr-mmproj.gguf"],
	},
	{
		id: "kokoro",
		path: "voice/kokoro",
		displayName: "Kokoro TTS",
		roles: ["tts", "voice"],
		capabilities: ["text-to-speech"],
		files: ["kokoro-v1.0-q4.onnx", "voices/af_bella.bin", "voices/af_same.bin"],
	},
	{
		id: "diarizer",
		path: "voice/diarizer",
		displayName: "Diarizer",
		roles: ["voice"],
		capabilities: ["speaker-embedding"],
	},
	{
		id: "wakeword",
		path: "voice/wakeword",
		displayName: "Wake word",
		roles: ["voice"],
		capabilities: ["voice-activity-detection"],
	},
	{
		id: "speaker-encoder",
		path: "voice/speaker-encoder",
		displayName: "Speaker encoder",
		roles: ["voice"],
		capabilities: ["speaker-embedding"],
	},
	{
		id: "vad",
		path: "voice/vad",
		displayName: "Voice activity detector",
		roles: ["vad", "voice"],
		capabilities: ["voice-activity-detection"],
	},
	{
		id: "embedding",
		path: "voice/embedding",
		displayName: "Voice embedding",
		roles: ["voice", "embedding"],
		capabilities: ["speaker-embedding"],
	},
	{
		id: "turn-detector",
		path: "voice/turn-detector",
		displayName: "Turn detector legacy path",
		roles: ["turn", "voice"],
		capabilities: ["turn-detection"],
	},
	{
		id: "voice-emotion",
		path: "voice/voice-emotion",
		displayName: "Voice emotion",
		roles: ["emotion", "voice"],
		capabilities: ["emotion-classification"],
	},
];

export function getEliza1CatalogSource(): {
	localCatalogPath: string;
	localCatalogPresent: boolean;
	activeTierIds: string[];
	sourceTextSha256?: string;
} {
	const present = fs.existsSync(LOCAL_CATALOG_PATH);
	const source: {
		localCatalogPath: string;
		localCatalogPresent: boolean;
		activeTierIds: string[];
		sourceTextSha256?: string;
	} = {
		localCatalogPath: LOCAL_CATALOG_PATH,
		localCatalogPresent: present,
		activeTierIds: [
			"eliza-1-0_8b",
			"eliza-1-2b",
			"eliza-1-4b",
			"eliza-1-9b",
			"eliza-1-27b",
			"eliza-1-27b-256k",
		],
	};
	if (!present) return source;
	const text = fs.readFileSync(LOCAL_CATALOG_PATH, "utf8");
	const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
	source.sourceTextSha256 = digest;
	return source;
}

export function getEliza1BundleTiers(): Eliza1BundleTier[] {
	const source = getEliza1CatalogSource();
	return TIER_SNAPSHOTS.map((tier) => ({
		tier: tier.tier,
		bundlePath: `bundles/${tier.tier}`,
		displayName: tier.displayName,
		params: tier.params,
		visibleOnHf: true,
		activeTier: tier.activeTier,
		contextLength: tier.contextLength,
		roles: tier.roles,
		capabilities: tier.capabilities,
		raw: {
			defaultQuantization: "Q4_K_M",
			higherPrecisionVariants: ["Q6_K", "Q8_0"],
			localCatalog: source,
			...tier.source,
		},
	}));
}

export function getEliza1VoiceComponents(): Eliza1VoiceComponent[] {
	return VOICE_COMPONENTS.map((component) => ({
		...component,
		raw: {
			hfRepo: ELIZA_1_HF_REPO,
			installed: false,
			usable: false,
		},
	}));
}

export function getEliza1Catalog(): LocalModelCatalogEntry[] {
	const source = getEliza1CatalogSource();
	return TIER_SNAPSHOTS.map((tier) => ({
		id: `eliza-1-${tier.tier}`,
		displayName: tier.displayName,
		provider: "eliza-1",
		family: "eliza-1",
		hfRepo: ELIZA_1_HF_REPO,
		bundlePath: `bundles/${tier.tier}`,
		tier: tier.tier,
		params: tier.params,
		sizeGb: tier.sizeGb,
		minRamGb: tier.minRamGb,
		contextLength: tier.contextLength,
		quantization: "Q4_K_M",
		roles: tier.roles,
		capabilities: tier.capabilities,
		default: tier.defaultTier === true,
		source: {
			localCatalog: source,
			eliza1BaseLineage: "Qwen",
			fineTuned: false,
		},
		raw: {
			visibleOnHf: true,
			activeTier: tier.activeTier,
			supportedRunners: [
				"llama.cpp",
				"Ollama",
				"Docker Model Runner",
				"LM Studio",
				"Jan",
				"Unsloth Studio",
				"Lemonade",
			],
			higherPrecisionVariants: ["Q6_K", "Q8_0"],
		},
	}));
}

function resolveLocalCatalogPath(): string {
	const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
	for (const start of starts) {
		let current = path.resolve(start);
		while (true) {
			const candidate = path.join(
				current,
				"packages/shared/src/local-inference/catalog.ts",
			);
			if (fs.existsSync(candidate)) return candidate;
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return path.resolve(
		process.cwd(),
		"packages/shared/src/local-inference/catalog.ts",
	);
}
