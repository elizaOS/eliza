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
    default: TTSModelSpec;
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
    name: "text/eliza-1-4b-64k.gguf",
    repo: "elizaos/eliza-1",
    size: "4B",
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
      name: "tts/omnivoice-small.gguf",
      repo: "elizaos/eliza-1",
      size: "bundle component",
      quantization: "fused GGUF",
      speakers: ["default"],
      languages: ["en"],
      features: ["streaming", "barge-in", "dflash"],
      maxInputLength: 4096,
      sampleRate: 24000,
      contextSize: 4096,
      tokenizer: {
        name: "tts/omnivoice-tokenizer-small.gguf",
        type: "omnivoice",
      },
    },
  },
};
