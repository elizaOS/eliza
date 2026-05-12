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
    name: "text/eliza-1-2b-32k.gguf",
    repo: "elizaos/eliza-1",
    size: "2B",
    quantization: "fused GGUF",
    contextSize: 32768,
    tokenizer: {
      name: "elizaos/eliza-1",
      type: "eliza1",
    },
  },
  medium: {
    name: "text/eliza-1-9b-64k.gguf",
    repo: "elizaos/eliza-1",
    size: "9B",
    quantization: "fused GGUF",
    contextSize: 65536,
    tokenizer: {
      name: "elizaos/eliza-1",
      type: "eliza1",
    },
  },
  embedding: {
    name: "text/eliza-1-0_8b-32k.gguf",
    repo: "elizaos/eliza-1",
    size: "512 MB",
    quantization: "fused GGUF",
    contextSize: 32768,
    dimensions: 1024,
    tokenizer: {
      name: "elizaos/eliza-1",
      type: "eliza1",
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
    name: "Florence-2-base-ft",
    repo: "onnx-community/Florence-2-base-ft",
    size: "0.23B",
    modelId: "onnx-community/Florence-2-base-ft",
    contextSize: 1024,
    maxTokens: 256,
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
