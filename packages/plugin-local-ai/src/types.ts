// Model specifications and configurations
export interface TokenizerConfig {
	name: string;
	type: string;
}

export interface ModelSpec {
	name: string;
	repo: string;
	size: string;
	quantization: string;
	contextSize: number;
	tokenizer: TokenizerConfig;
}

export interface VisionModelSpec {
	name: string;
	repo: string;
	size: string;
	modelId: string;
	contextSize: number;
	maxTokens: number;
	tasks: string[];
}

export interface TTSModelSpec {
	name: string;
	repo: string;
	size: string;
	quantization: string;
	speakers: string[];
	languages: string[];
	features: string[];
	maxInputLength: number;
	sampleRate: number;
	contextSize: number;
	tokenizer: TokenizerConfig;
}

// Model specifications mapping
export interface ModelSpecs {
	small: ModelSpec;
	medium: ModelSpec;
	vision: VisionModelSpec;
	visionvl: VisionModelSpec;
	tts: {
		base: TTSModelSpec;
		medium: TTSModelSpec;
		large: TTSModelSpec;
	};
}

// Export MODEL_SPECS constant type
export const MODEL_SPECS: ModelSpecs = {
	small: {
		name: "DeepSeek-R1-Distill-Qwen-1.5B-Q8_0.gguf",
		repo: "unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
		size: "1.5B",
		quantization: "Q8_0",
		contextSize: 8192,
		tokenizer: {
			name: "deepseek-ai/deepseek-llm-7b-base",
			type: "llama",
		},
	},
	medium: {
		name: "DeepSeek-R1-Distill-Qwen-7B-Q8_0.gguf",
		repo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF",
		size: "7B",
		quantization: "Q8_0",
		contextSize: 8192,
		tokenizer: {
			name: "deepseek-ai/deepseek-llm-7b-base",
			type: "llama",
		},
	},
	vision: {
		name: "Florence-2-base-ft",
		repo: "onnx-community/Florence-2-base-ft",
		size: "0.23B",
		modelId: "onnx-community/Florence-2-base-ft",
		contextSize: 1024,
		maxTokens: 256,
		tasks: [
			"CAPTION",
			"DETAILED_CAPTION",
			"MORE_DETAILED_CAPTION",
			"CAPTION_TO_PHRASE_GROUNDING",
			"OD",
			"DENSE_REGION_CAPTION",
			"REGION_PROPOSAL",
			"OCR",
			"OCR_WITH_REGION",
		],
	},
	visionvl: {
		name: "Qwen2.5-VL-3B-Instruct",
		repo: "Qwen/Qwen2.5-VL-3B-Instruct",
		size: "3B",
		modelId: "Qwen/Qwen2.5-VL-3B-Instruct",
		contextSize: 32768,
		maxTokens: 1024,
		tasks: [
			"CAPTION",
			"DETAILED_CAPTION",
			"IMAGE_UNDERSTANDING",
			"VISUAL_QUESTION_ANSWERING",
			"OCR",
			"VISUAL_LOCALIZATION",
			"REGION_ANALYSIS",
		],
	},
	tts: {
		base: {
			name: "OuteTTS-0.2-500M-Q8_0.gguf",
			repo: "OuteAI/OuteTTS-0.2-500M-GGUF",
			size: "500M",
			quantization: "Q8_0",
			speakers: ["male_1", "male_2", "female_1", "female_2"],
			languages: ["en"],
			features: [
				"MULTI_SPEAKER",
				"VOICE_CLONING",
				"EMOTION_CONTROL",
				"SPEED_CONTROL",
			],
			maxInputLength: 4096,
			sampleRate: 24000,
			contextSize: 2048,
			tokenizer: {
				name: "OuteAI/OuteTTS-0.2-500M",
				type: "llama",
			},
		},
		medium: {
			name: "OuteTTS-0.3-1B.gguf",
			repo: "OuteAI/OuteTTS-0.3-1B-GGUF",
			size: "1B",
			quantization: "Q8_0",
			speakers: [
				"male_1",
				"male_2",
				"male_3",
				"female_1",
				"female_2",
				"female_3",
			],
			languages: ["en", "es", "fr", "de", "it"],
			features: [
				"MULTI_SPEAKER",
				"VOICE_CLONING",
				"EMOTION_CONTROL",
				"SPEED_CONTROL",
				"MULTILINGUAL",
				"ACCENT_CONTROL",
			],
			maxInputLength: 8192,
			sampleRate: 32000,
			contextSize: 4096,
			tokenizer: {
				name: "OuteAI/OuteTTS-0.3-1B",
				type: "llama",
			},
		},
		large: {
			name: "OuteTTS-0.3-3B.gguf",
			repo: "OuteAI/OuteTTS-0.3-3B-GGUF",
			size: "3B",
			quantization: "Q8_0",
			speakers: [
				"male_1",
				"male_2",
				"male_3",
				"male_4",
				"female_1",
				"female_2",
				"female_3",
				"female_4",
			],
			languages: [
				"en",
				"es",
				"fr",
				"de",
				"it",
				"pt",
				"nl",
				"pl",
				"ru",
				"ja",
				"ko",
				"zh",
			],
			features: [
				"MULTI_SPEAKER",
				"VOICE_CLONING",
				"EMOTION_CONTROL",
				"SPEED_CONTROL",
				"MULTILINGUAL",
				"ACCENT_CONTROL",
				"STYLE_TRANSFER",
				"PROSODY_CONTROL",
			],
			maxInputLength: 16384,
			sampleRate: 48000,
			contextSize: 8192,
			tokenizer: {
				name: "OuteAI/OuteTTS-0.3-3B",
				type: "llama",
			},
		},
	},
};
