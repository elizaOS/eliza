// Model specifications and configurations
/**
 * Interface representing a Tokenizer configuration.
 * @property {string} name - The name of the tokenizer.
 * @property {string} type - The type of the tokenizer.
 */
export interface TokenizerConfig {
  name: string;
  type: string;
}

/**
 * Interface representing the specification of a model.
 * @typedef {Object} ModelSpec
 * @property {string} name - The name of the model.
 * @property {string} repo - The repository of the model.
 * @property {string} size - The size of the model.
 * @property {string} quantization - The quantization of the model.
 * @property {number} contextSize - The context size of the model.
 * @property {TokenizerConfig} tokenizer - The configuration for the tokenizer used by the model.
 */
export interface ModelSpec {
  name: string;
  repo: string;
  size: string;
  quantization: string;
  contextSize: number;
  tokenizer: TokenizerConfig;
}

/**
 * Interface representing the specification of an embedding model.
 * @typedef {Object} EmbeddingModelSpec
 * @property {string} name - The name of the embedding model.
 * @property {string} repo - The repository of the embedding model.
 * @property {string} size - The size of the embedding model.
 * @property {string} quantization - The quantization of the embedding model.
 * @property {number} contextSize - The context size of the embedding model.
 * @property {number} dimensions - The embedding dimensions.
 * @property {TokenizerConfig} tokenizer - The configuration for the tokenizer used by the model.
 */
export interface EmbeddingModelSpec extends ModelSpec {
  dimensions: number;
}

/**
 * Interface representing a specification for a vision model.
 * @typedef {object} VisionModelSpec
 * @property {string} name - The name of the vision model.
 * @property {string} repo - The repository of the vision model.
 * @property {string} size - The size of the vision model.
 * @property {string} modelId - The ID of the vision model.
 * @property {number} contextSize - The context size of the vision model.
 * @property {number} maxTokens - The maximum tokens of the vision model.
 * @property {Array.<string>} tasks - The tasks performed by the vision model.
 */
export interface VisionModelSpec {
  name: string;
  repo: string;
  size: string;
  modelId: string;
  contextSize: number;
  maxTokens: number;
  tasks: string[];
}

/**
 * Interface representing the specification for a TTS model.
 * @typedef { Object } TTSModelSpec
 * @property { string } name - The name of the model.
 * @property { string } repo - The repository where the model is stored.
 * @property { string } size - The size of the model.
 * @property { string } quantization - The quantization method used for the model.
 * @property {string[]} speakers - An array of speakers the model can mimic.
 * @property {string[]} languages - An array of languages the model can speak in.
 * @property {string[]} features - An array of features supported by the model.
 * @property { number } maxInputLength - The maximum input length accepted by the model.
 * @property { number } sampleRate - The sample rate used by the model.
 * @property { number } contextSize - The context size used by the model.
 * @property { TokenizerConfig } tokenizer - The configuration for the tokenizer used by the model.
 */
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
/**
 * Interface for specifying different models for a project.
 * @interface ModelSpecs
 * @property {ModelSpec} small - Specifications for a small model
 * @property {ModelSpec} medium - Specifications for a medium model
 * @property {EmbeddingModelSpec} embedding - Specifications for an embedding model
 * @property {VisionModelSpec} vision - Specifications for a vision model
 * @property {VisionModelSpec} visionvl - Specifications for a vision model with vision loss
 * @property {Object} tts - Specifications for text-to-speech models
 * @property {TTSModelSpec} tts.base - Specifications for the base text-to-speech model
 * @property {TTSModelSpec} tts.medium - Specifications for a medium text-to-speech model
 * @property {TTSModelSpec} tts.large - Specifications for a large text-to-speech model
 */
export interface ModelSpecs {
  small: ModelSpec;
  medium: ModelSpec;
  embedding: EmbeddingModelSpec;
  vision: VisionModelSpec;
  visionvl: VisionModelSpec;
  tts: {
    base: TTSModelSpec;
    medium: TTSModelSpec;
    large: TTSModelSpec;
  };
}

// Export MODEL_SPECS constant type
/**
 * Model specifications containing information about various models such as name, repository, size, quantization, context size, tokenizer details, tasks, speakers, languages, features, max input length, sample rate, and other relevant information.
 */
export const MODEL_SPECS: ModelSpecs = {
  small: {
    name: 'DeepHermes-3-Llama-3-3B-Preview-q4.gguf',
    repo: 'NousResearch/DeepHermes-3-Llama-3-3B-Preview-GGUF',
    size: '3B',
    quantization: 'Q4_0',
    contextSize: 8192,
    tokenizer: {
      name: 'NousResearch/DeepHermes-3-Llama-3-3B-Preview',
      type: 'llama',
    },
  },
  medium: {
    name: 'DeepHermes-3-Llama-3-8B-q4.gguf',
    repo: 'NousResearch/DeepHermes-3-Llama-3-8B-Preview-GGUF',
    size: '8B',
    quantization: 'Q4_0',
    contextSize: 8192,
    tokenizer: {
      name: 'NousResearch/DeepHermes-3-Llama-3-8B-Preview',
      type: 'llama',
    },
  },
  embedding: {
    name: 'bge-small-en-v1.5.Q4_K_M.gguf',
    repo: 'ChristianAzinn/bge-small-en-v1.5-gguf',
    size: '133 MB',
    quantization: 'Q4_K_M',
    contextSize: 512,
    dimensions: 384,
    tokenizer: {
      name: 'ChristianAzinn/bge-small-en-v1.5-gguf',
      type: 'llama',
    },
  },
  vision: {
    name: 'Florence-2-base-ft',
    repo: 'onnx-community/Florence-2-base-ft',
    size: '0.23B',
    modelId: 'onnx-community/Florence-2-base-ft',
    contextSize: 1024,
    maxTokens: 256,
    tasks: [
      'CAPTION',
      'DETAILED_CAPTION',
      'MORE_DETAILED_CAPTION',
      'CAPTION_TO_PHRASE_GROUNDING',
      'OD',
      'DENSE_REGION_CAPTION',
      'REGION_PROPOSAL',
      'OCR',
      'OCR_WITH_REGION',
    ],
  },
  visionvl: {
    name: 'Qwen2.5-VL-3B-Instruct',
    repo: 'Qwen/Qwen2.5-VL-3B-Instruct',
    size: '3B',
    modelId: 'Qwen/Qwen2.5-VL-3B-Instruct',
    contextSize: 32768,
    maxTokens: 1024,
    tasks: [
      'CAPTION',
      'DETAILED_CAPTION',
      'IMAGE_UNDERSTANDING',
      'VISUAL_QUESTION_ANSWERING',
      'OCR',
      'VISUAL_LOCALIZATION',
      'REGION_ANALYSIS',
    ],
  },
  tts: {
    base: {
      name: 'OuteTTS-0.2-500M-Q8_0.gguf',
      repo: 'OuteAI/OuteTTS-0.2-500M-GGUF',
      size: '500M',
      quantization: 'Q8_0',
      speakers: ['male_1', 'male_2', 'female_1', 'female_2'],
      languages: ['en'],
      features: ['MULTI_SPEAKER', 'VOICE_CLONING', 'EMOTION_CONTROL', 'SPEED_CONTROL'],
      maxInputLength: 4096,
      sampleRate: 24000,
      contextSize: 2048,
      tokenizer: {
        name: 'OuteAI/OuteTTS-0.2-500M',
        type: 'llama',
      },
    },
    medium: {
      name: 'OuteTTS-0.3-1B.gguf',
      repo: 'OuteAI/OuteTTS-0.3-1B-GGUF',
      size: '1B',
      quantization: 'Q8_0',
      speakers: ['male_1', 'male_2', 'male_3', 'female_1', 'female_2', 'female_3'],
      languages: ['en', 'es', 'fr', 'de', 'it'],
      features: [
        'MULTI_SPEAKER',
        'VOICE_CLONING',
        'EMOTION_CONTROL',
        'SPEED_CONTROL',
        'MULTILINGUAL',
        'ACCENT_CONTROL',
      ],
      maxInputLength: 8192,
      sampleRate: 32000,
      contextSize: 4096,
      tokenizer: {
        name: 'OuteAI/OuteTTS-0.3-1B',
        type: 'llama',
      },
    },
    large: {
      name: 'OuteTTS-0.3-3B.gguf',
      repo: 'OuteAI/OuteTTS-0.3-3B-GGUF',
      size: '3B',
      quantization: 'Q8_0',
      speakers: [
        'male_1',
        'male_2',
        'male_3',
        'male_4',
        'female_1',
        'female_2',
        'female_3',
        'female_4',
      ],
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh'],
      features: [
        'MULTI_SPEAKER',
        'VOICE_CLONING',
        'EMOTION_CONTROL',
        'SPEED_CONTROL',
        'MULTILINGUAL',
        'ACCENT_CONTROL',
        'STYLE_TRANSFER',
        'PROSODY_CONTROL',
      ],
      maxInputLength: 16384,
      sampleRate: 48000,
      contextSize: 8192,
      tokenizer: {
        name: 'OuteAI/OuteTTS-0.3-3B',
        type: 'llama',
      },
    },
  },
};
