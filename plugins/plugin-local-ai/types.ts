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

export interface EmbeddingModelSpec extends ModelSpec {
  dimensions: number;
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

export interface TransformersJsTTSModelSpec {
  modelId: string;
  defaultSampleRate: number;
  defaultSpeakerEmbeddingUrl?: string;
}

export interface ModelSpecs {
  small: ModelSpec;
  medium: ModelSpec;
  embedding: EmbeddingModelSpec;
  vision: VisionModelSpec;
  visionvl: VisionModelSpec;
  tts: {
    default: TransformersJsTTSModelSpec;
  };
}

export const MODEL_SPECS: ModelSpecs = {
  small: {
    name: "DeepHermes-3-Llama-3-3B-Preview-q4.gguf",
    repo: "NousResearch/DeepHermes-3-Llama-3-3B-Preview-GGUF",
    size: "3B",
    quantization: "Q4_0",
    contextSize: 8192,
    tokenizer: {
      name: "NousResearch/DeepHermes-3-Llama-3-3B-Preview",
      type: "llama",
    },
  },
  medium: {
    name: "DeepHermes-3-Llama-3-8B-q4.gguf",
    repo: "NousResearch/DeepHermes-3-Llama-3-8B-Preview-GGUF",
    size: "8B",
    quantization: "Q4_0",
    contextSize: 8192,
    tokenizer: {
      name: "NousResearch/DeepHermes-3-Llama-3-8B-Preview",
      type: "llama",
    },
  },
  embedding: {
    name: "bge-small-en-v1.5.Q4_K_M.gguf",
    repo: "ChristianAzinn/bge-small-en-v1.5-gguf",
    size: "133 MB",
    quantization: "Q4_K_M",
    contextSize: 512,
    dimensions: 384,
    tokenizer: {
      name: "ChristianAzinn/bge-small-en-v1.5-gguf",
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
    default: {
      modelId: "Xenova/speecht5_tts",
      defaultSampleRate: 16000,
      defaultSpeakerEmbeddingUrl:
        "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin",
    },
  },
};
