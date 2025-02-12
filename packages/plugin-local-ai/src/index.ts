import { type IAgentRuntime, logger, ModelClass, type Plugin } from "@elizaos/core";
import {
  AutoProcessor,
  AutoTokenizer,
  env,
  Florence2ForConditionalGeneration,
  type Florence2Processor,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  RawImage,
  type Tensor,
} from "@huggingface/transformers";
import { exec } from "node:child_process";
import * as Echogarden from "echogarden";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import fs from "node:fs";
import {
  getLlama,
  type Llama,
  LlamaChatSession,
  type LlamaChatSessionRepeatPenalty,
  type LlamaContext,
  type LlamaContextSequence,
  type LlamaModel
} from "node-llama-cpp";
import { nodewhisper } from "nodejs-whisper";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration schema
const configSchema = z.object({
  LLAMALOCAL_PATH: z.string().optional(),
  OLLAMA_MODEL: z.string().optional(),
  TOKENIZER_MODEL: z.string().optional().default("gpt-4o"),
  CACHE_DIR: z.string().optional().default("./cache"),
  VITS_VOICE: z.string().optional(),
  VITS_MODEL: z.string().optional(),
});

// Utility functions
function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(channelCount, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28);
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(audioLength, 40);
  return wavHeader;
}

function prependWavHeader(
  readable: Readable,
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Readable {
  const wavHeader = getWavHeader(audioLength, sampleRate, channelCount, bitsPerSample);
  let pushedHeader = false;
  const passThrough = new PassThrough();
  readable.on("data", (data) => {
    if (!pushedHeader) {
      passThrough.push(wavHeader);
      pushedHeader = true;
    }
    passThrough.push(data);
  });
  readable.on("end", () => {
    passThrough.end();
  });
  return passThrough;
}

// Words to punish in LLM responses
const wordsToPunish = [
  " please", " feel", " free", "!", "–", "—", "?", ".", ",", "; ",
  " cosmos", " tapestry", " tapestries", " glitch", " matrix", " cyberspace",
  " troll", " questions", " topics", " discuss", " basically", " simulation",
  " simulate", " universe", " like", " debug", " debugging", " wild",
  " existential", " juicy", " circuits", " help", " ask", " happy", " just",
  " cosmic", " cool", " joke", " punchline", " fancy", " glad", " assist",
  " algorithm", " Indeed", " Furthermore", " However", " Notably", " Therefore"
];

class LocalAIManager {
  private static instance: LocalAIManager | null = null;
  private llama: Llama | undefined;
  private model: LlamaModel | undefined;
  private modelPath: string;
  private grammar: any;
  private ctx: LlamaContext | undefined;
  private sequence: LlamaContextSequence | undefined;
  tokenizer: any;
  private embeddingModel: FlagEmbedding | null = null;
  private embeddingInitPromise: Promise<void> | null = null;
  private embeddingInitLock = false;
  private florenceModel: PreTrainedModel | null = null;
  private florenceProcessor: Florence2Processor | null = null;
  private florenceTokenizer: PreTrainedTokenizer | null = null;
  private isCudaAvailable = false;
  private CONTENT_CACHE_DIR: string;
  private TARGET_SAMPLE_RATE = 16000;

  constructor() {
    const modelName = "model.gguf";
    this.modelPath = path.join(process.env.LLAMALOCAL_PATH?.trim() ?? "./", modelName);
    this.CONTENT_CACHE_DIR = path.join(__dirname, "../../content_cache");
    this.ensureCacheDirectoryExists();
    this.detectCuda();
  }

  private ensureCacheDirectoryExists() {
    if (!fs.existsSync(this.CONTENT_CACHE_DIR)) {
      fs.mkdirSync(this.CONTENT_CACHE_DIR, { recursive: true });
    }
  }

  private async detectCuda() {
    const platform = os.platform();
    if (platform === "linux") {
      try {
        fs.accessSync("/usr/local/cuda/bin/nvcc", fs.constants.X_OK);
        this.isCudaAvailable = true;
        logger.log("CUDA detected. Acceleration available.");
      } catch {
        logger.log("CUDA not detected. Using CPU only.");
      }
    } else if (platform === "win32") {
      const cudaPath = process.env.CUDA_PATH || "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v11.0";
      if (fs.existsSync(path.join(cudaPath, "bin", "nvcc.exe"))) {
        this.isCudaAvailable = true;
        logger.log("CUDA detected. Acceleration available.");
      }
    }
  }

  async initialize() {
    await this.initializeLlama();
    await this.initializeFlorence();
    await this.initializeTokenizer();
    await this.initializeEmbedding();
  }

  private async initializeLlama() {
    try {
      if (!fs.existsSync(this.modelPath)) {
        logger.info("Downloading LLaMA model...");
        // Add model download logic here
      }

      this.llama = await getLlama({
        gpu: this.isCudaAvailable ? "cuda" : undefined,
      });

      this.model = await this.llama.loadModel({
        modelPath: this.modelPath,
      });

      this.ctx = await this.model.createContext({ contextSize: 8192 });
      this.sequence = this.ctx.getSequence();
      
      logger.success("LLaMA initialization complete");
    } catch (error) {
      logger.error("LLaMA initialization failed:", error);
      throw error;
    }
  }

  private async initializeFlorence() {
    try {
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.backends.onnx.logLevel = "fatal";
      const modelId = "onnx-community/Florence-2-base-ft";

      logger.info("Downloading Florence model...");
      this.florenceModel = await Florence2ForConditionalGeneration.from_pretrained(modelId, {
        device: "gpu",
        progress_callback: (progress) => {
          if (progress.status === "download") {
            const percent = (((progress as any).loaded / (progress as any).total) * 100).toFixed(1);
            const dots = ".".repeat(Math.floor(Number(percent) / 5));
            logger.info(`Downloading Florence model: [${dots.padEnd(20, " ")}] ${percent}%`);
          }
        },
      });

      logger.info("Downloading processor...");
      this.florenceProcessor = await AutoProcessor.from_pretrained(modelId, {
        device: "gpu",
        progress_callback: (progress) => {
          if (progress.status === "download") {
            const percent = ((progress.loaded / progress.total) * 100).toFixed(1);
            const dots = ".".repeat(Math.floor(Number(percent) / 5));
            logger.info(`Downloading Florence model: [${dots.padEnd(20, " ")}] ${percent}%`);
          }
        },
      }) as Florence2Processor;

      logger.info("Downloading tokenizer...");
      this.florenceTokenizer = await AutoTokenizer.from_pretrained(modelId);
      
      logger.success("Florence initialization complete");
    } catch (error) {
      logger.error("Florence initialization failed:", error);
      throw error;
    }
  }

  private async initializeEmbedding(): Promise<void> {
    // If already initialized, return immediately
    if (this.embeddingModel) {
      return;
    }

    // If initialization is in progress, wait for it
    if (this.embeddingInitPromise) {
      return this.embeddingInitPromise;
    }

    // Use a lock to prevent multiple simultaneous initializations
    if (this.embeddingInitLock) {
      // Wait for current initialization to complete
      while (this.embeddingInitLock) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.embeddingInitLock = true;

    try {
      this.embeddingInitPromise = this.initializeEmbeddingModel();
      await this.embeddingInitPromise;
    } finally {
      this.embeddingInitLock = false;
      this.embeddingInitPromise = null;
    }
  }

  private async initializeEmbeddingModel(): Promise<void> {
    try {
      const cacheDir = path.resolve(__dirname, process.env.CACHE_DIR || "./cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      logger.debug("Initializing BGE embedding model...");
      this.embeddingModel = await FlagEmbedding.init({
        cacheDir: cacheDir,
        model: EmbeddingModel.BGESmallENV15,
        maxLength: 512,
      });
      
      logger.success("Embedding model initialization complete");
    } catch (error) {
      logger.error("Embedding initialization failed:", error);
      throw error;
    }
  }

  // LLaMA text generation
  async generateText(context: string, temperature = 0.7, stopSequences: string[] = []): Promise<string> {
    if (!this.sequence) {
      throw new Error("LLaMA model not initialized");
    }
    const session = new LlamaChatSession({ contextSequence: this.sequence });
    if (!this.model) {
      throw new Error("Model is not initialized");
    }
    const wordsToPunishTokens = wordsToPunish.flatMap((word) => this.model.tokenize(word));

    const repeatPenalty: LlamaChatSessionRepeatPenalty = {
      punishTokensFilter: () => wordsToPunishTokens,
      penalty: 1.2,
      frequencyPenalty: 0.7,
      presencePenalty: 0.7,
    };

    const response = await session.prompt(context, {
      temperature: temperature,
      repeatPenalty: repeatPenalty,
    });

    await this.sequence.clearHistory();
    return response || "";
  }

  private async initializeTokenizer() {
    try {
      const tokenizerModel = process.env.TOKENIZER_MODEL || "gpt-4o";
      this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerModel);
      logger.success(`Tokenizer initialized with model: ${tokenizerModel}`);
    } catch (error) {
      logger.error("Tokenizer initialization failed:", error);
      throw error;
    }
  }

  // Embedding generation
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingModel) {
      await this.initializeEmbedding();
      throw new Error("Embedding model not initialized");
    }

    const embedding = await this.embeddingModel.queryEmbed(text);
    return Array.from(embedding);
  }

  // Image description
  async describeImage(imageData: Buffer, mimeType: string): Promise<{ title: string; description: string }> {
    if (!this.florenceModel || !this.florenceProcessor || !this.florenceTokenizer) {
      throw new Error("Florence model not initialized");
    }

    const blob = new Blob([imageData], { type: mimeType });
    const image = await RawImage.fromBlob(blob as any);
    const visionInputs = await this.florenceProcessor(image);
    const prompts = this.florenceProcessor.construct_prompts("<DETAILED_CAPTION>");
    const textInputs = this.florenceTokenizer(prompts);

    const generatedIds = await this.florenceModel.generate({
      ...textInputs,
      ...visionInputs,
      max_new_tokens: 256,
    }) as Tensor;

    const generatedText = this.florenceTokenizer.batch_decode(generatedIds, {
      skip_special_tokens: false,
    })[0];

    const result = this.florenceProcessor.post_process_generation(
      generatedText,
      "<DETAILED_CAPTION>",
      image.size
    );

    const detailedCaption = result["<DETAILED_CAPTION>"] as string;
    return { title: detailedCaption, description: detailedCaption };
  }

  // Audio transcription
  async transcribeAudio(audioBuffer: ArrayBuffer): Promise<string | null> {
    try {
      if (audioBuffer.byteLength < 0.2 * 16000) {
        return null;
      }

      const arrayBuffer = new Uint8Array(audioBuffer).buffer;
      const tempWavFile = path.join(this.CONTENT_CACHE_DIR, `temp_${Date.now()}.wav`);
      fs.writeFileSync(tempWavFile, Buffer.from(arrayBuffer));

      const output = await nodewhisper(tempWavFile, {
        modelName: "base.en",
        autoDownloadModelName: "base.en",
        verbose: false,
        withCuda: this.isCudaAvailable,
        whisperOptions: {
          outputInText: true,
          translateToEnglish: false,
        },
      });

      fs.unlinkSync(tempWavFile);
      
      if (!output || output.length < 5) {
        return null;
      }

      return output.split("\n")
        .map(line => line.trim().startsWith("[") ? line.substring(line.indexOf("]") + 1) : line)
        .join("\n");
    } catch (error) {
      logger.error("Transcription error:", error);
      return null;
    }
  }

  // Text to speech
  async generateSpeech(runtime: IAgentRuntime, text: string): Promise<Readable> {
    try {
      const voiceSettings = runtime.character.settings?.voice;

      const vitsVoice = voiceSettings?.model || process.env.VITS_VOICE || "en_US-hfc_female-medium";
      const { audio } = await Echogarden.synthesize(text, {
        engine: "vits",
        voice: vitsVoice,
      });

      return this.processVitsAudio(audio);
    } catch (error) {
      logger.error("Speech generation error:", error);
      throw error;
    }
  }

  private async processVitsAudio(audio: any): Promise<Readable> {
    if (audio instanceof Buffer) {
      return Readable.from(audio);
    }

    if ("audioChannels" in audio && "sampleRate" in audio) {
      const floatBuffer = Buffer.from(audio.audioChannels[0].buffer);
      const floatArray = new Float32Array(floatBuffer.buffer);
      const pcmBuffer = new Int16Array(floatArray.length);

      for (let i = 0; i < floatArray.length; i++) {
        pcmBuffer[i] = Math.round(floatArray[i] * 32767);
      }

      const wavHeaderBuffer = getWavHeader(pcmBuffer.length * 2, audio.sampleRate, 1, 16);
      const wavBuffer = Buffer.concat([wavHeaderBuffer, Buffer.from(pcmBuffer.buffer)]);
      return Readable.from(wavBuffer);
    }

    throw new Error("Unsupported audio format");
  }
}

// Create manager instance
const localAIManager = new LocalAIManager();

export const localAIPlugin: Plugin = {
  name: "local-ai",
  description: "Local AI plugin using LLaMA, Florence, and other local models",

  async init(config: Record<string, string>) {
    try {
      const validatedConfig = await configSchema.parseAsync(config);
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) {
          process.env[key] = value;
        }
      }

      await localAIManager.initialize();
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors.map((e) => e.message).join(", ")}`
        );
      }
      throw error;
    }
  },

  models: {
    [ModelClass.TEXT_SMALL]: async (runtime, { context, stopSequences = [], temperature = 0.7 }) => {
      try {
        return await localAIManager.generateText(context, temperature, stopSequences);
      } catch (error) {
        logger.error("Error in TEXT_SMALL handler:", error);
        throw error;
      }
    },

    [ModelClass.TEXT_LARGE]: async (runtime, { context, stopSequences = [], temperature = 0.7 }) => {
      try {
        return await localAIManager.generateText(context, temperature, stopSequences);
      } catch (error) {
        logger.error("Error in TEXT_LARGE handler:", error);
        throw error;
      }
    },

    [ModelClass.TEXT_EMBEDDING]: async (runtime, text) => {
      try {
        return await localAIManager.generateEmbedding(text);
      } catch (error) {
        logger.error("Error in TEXT_EMBEDDING handler:", error);
        throw error;
      }
    },

    [ModelClass.TEXT_TOKENIZER_ENCODE]: async (runtime, { text }) => {
      try {
        return await localAIManager.tokenizer.encode(text);
      } catch (error) {
        logger.error("Error in TEXT_TOKENIZER_ENCODE handler:", error);
        throw error;
      }
    },

    [ModelClass.TEXT_TOKENIZER_DECODE]: async (runtime, { tokens }) => {
      try {
        return await localAIManager.tokenizer.decode(tokens);
      } catch (error) {
        logger.error("Error in TEXT_TOKENIZER_DECODE handler:", error);
        throw error;
      }
    },

    [ModelClass.IMAGE_DESCRIPTION]: async (runtime, imageUrl) => {
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.statusText}`);
        }
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        const mimeType = response.headers.get("content-type") || "image/jpeg";
        return await localAIManager.describeImage(imageBuffer, mimeType);
      } catch (error) {
        logger.error("Error in IMAGE_DESCRIPTION handler:", error);
        throw error;
      }
    },

    [ModelClass.TRANSCRIPTION]: async (runtime, audioBuffer) => {
      try {
        return await localAIManager.transcribeAudio(audioBuffer);
      } catch (error) {
        logger.error("Error in TRANSCRIPTION handler:", error);
        throw error;
      }
    },

    [ModelClass.TEXT_TO_SPEECH]: async (runtime, text) => {
      try {
        return await localAIManager.generateSpeech(runtime, text);
      } catch (error) {
        logger.error("Error in SPEECH_GENERATION handler:", error);
        throw error;
      }
    }
  }
};

export default localAIPlugin;