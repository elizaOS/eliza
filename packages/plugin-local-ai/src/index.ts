import type { GenerateTextParams, ModelType } from "@elizaos/core";
import {
	type IAgentRuntime,
	logger,
	ModelTypes,
	type Plugin,
} from "@elizaos/core";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import {
	getLlama,
	type Llama,
	LlamaChatSession,
	type LlamaContext,
	type LlamaContextSequence,
	type LlamaModel,
} from "node-llama-cpp";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { getPlatformManager } from "./utils/platform";
import { TokenizerManager } from "./utils/tokenizerManager";
import { MODEL_SPECS, type ModelSpec } from "./types";
import { DownloadManager } from "./utils/downloadManager";
import { OllamaManager } from "./utils/ollamaManager";
import { StudioLMManager } from "./utils/studiolmManager";
import { TranscribeManager } from "./utils/transcribeManager";
import { TTSManager } from "./utils/ttsManager";
import { VisionManager } from "./utils/visionManager";
import { validateConfig } from "./environment";

// const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Words to punish in LLM responses
/**
 * Array containing words that should trigger a punishment when used in a message.
 * This array includes words like "please", "feel", "free", punctuation marks, and various topic-related words.
 * @type {string[]}
 */
const wordsToPunish = [
	" please",
	" feel",
	" free",
	"!",
	"–",
	"—",
	"?",
	".",
	",",
	"; ",
	" cosmos",
	" tapestry",
	" tapestries",
	" glitch",
	" matrix",
	" cyberspace",
	" troll",
	" questions",
	" topics",
	" discuss",
	" basically",
	" simulation",
	" simulate",
	" universe",
	" like",
	" debug",
	" debugging",
	" wild",
	" existential",
	" juicy",
	" circuits",
	" help",
	" ask",
	" happy",
	" just",
	" cosmic",
	" cool",
	" joke",
	" punchline",
	" fancy",
	" glad",
	" assist",
	" algorithm",
	" Indeed",
	" Furthermore",
	" However",
	" Notably",
	" Therefore",
];

// Add type definitions for model source selection
/**
 * Represents the available sources for a text model: "local", "studiolm", or "ollama".
 */
type TextModelSource = "local" | "studiolm" | "ollama";

/**
 * Interface representing the configuration for a text model.
 *
 * @property {TextModelSource} source - The source of the text model.
 * @property {ModelType} modelType - The type of the model.
 */
interface TextModelConfig {
	source: TextModelSource;
	modelType: ModelType;
}

/**
 * Class representing a LocalAIManager.
 * @property {LocalAIManager | null} instance - The static instance of LocalAIManager.
 * @property {Llama | undefined} llama - The llama object.
 * @property {LlamaModel | undefined} smallModel - The small LlamaModel object.
 * @property {LlamaModel | undefined} mediumModel - The medium LlamaModel object.
 * @property {LlamaContext | undefined} ctx - The LlamaContext object.
 * @property {LlamaContextSequence | undefined} sequence - The LlamaContextSequence object.
 * @property {LlamaChatSession | undefined} chatSession - The LlamaChatSession object.
 * @property {string} modelPath - The path to the model.
 */
class LocalAIManager {
	private static instance: LocalAIManager | null = null;
	private llama: Llama | undefined;
	private smallModel: LlamaModel | undefined;
	private mediumModel: LlamaModel | undefined;
	private ctx: LlamaContext | undefined;
	private sequence: LlamaContextSequence | undefined;
	private chatSession: LlamaChatSession | undefined;
	private modelPath: string;
	private mediumModelPath: string;
	private cacheDir: string;
	private embeddingModel: FlagEmbedding | null = null;
	private tokenizerManager: TokenizerManager;
	private downloadManager: DownloadManager;
	private visionManager: VisionManager;
	private activeModelConfig: ModelSpec;
	private transcribeManager: TranscribeManager;
	private ttsManager: TTSManager;
	private studioLMManager: StudioLMManager;
	private ollamaManager: OllamaManager;
	private ollamaInitialized = false;
	private studioLMInitialized = false;
	private modelsDir: string;

	/**
	 * Private constructor function to initialize various managers and services.
	 * This function sets up model directories, initializes managers for download, tokenizer, vision, transcribe, and TTS.
	 * It also initializes StudioLM and Ollama managers if enabled in the environment.
	 * Additionally, this function initializes the environment, checks platform capabilities, sets up embeddings,
	 * and initializes various models and services sequentially and in parallel to avoid conflicts.
	 */
	private constructor() {
		// Set up models directory consistently, similar to cacheDir
		const modelsDir = path.join(process.cwd(), "models");

		// logger.info("Models directory configuration:", {
		//   resolvedModelsDir: modelsDir,
		//   cwd: process.cwd()
		// });

		this.activeModelConfig = MODEL_SPECS.small;
		this.modelPath = path.join(modelsDir, MODEL_SPECS.small.name);
		this.mediumModelPath = path.join(modelsDir, MODEL_SPECS.medium.name);
		this.cacheDir = path.join(process.cwd(), "./cache");
		this.modelsDir = modelsDir;

		// logger.info("Path configuration:", {
		//   smallModelPath: this.modelPath,
		//   mediumModelPath: this.mediumModelPath,
		//   cacheDir: this.cacheDir,
		//   modelsDir: this.modelsDir
		// });

		this.downloadManager = DownloadManager.getInstance(
			this.cacheDir,
			this.modelsDir,
		);
		this.tokenizerManager = TokenizerManager.getInstance(
			this.cacheDir,
			this.modelsDir,
		);
		this.visionManager = VisionManager.getInstance(this.cacheDir);
		this.transcribeManager = TranscribeManager.getInstance(this.cacheDir);
		this.ttsManager = TTSManager.getInstance(this.cacheDir);

		// Only create StudioLM and Ollama manager instances if enabled in environment
		if (process.env.USE_STUDIOLM_TEXT_MODELS === "true") {
			logger.info(
				"Creating StudioLM manager instance (enabled in environment)",
			);
			this.studioLMManager = StudioLMManager.getInstance();
		} else {
			logger.info(
				"StudioLM manager instance not created (disabled in environment)",
			);
		}

		if (process.env.USE_OLLAMA_TEXT_MODELS === "true") {
			logger.info("Creating Ollama manager instance (enabled in environment)");
			this.ollamaManager = OllamaManager.getInstance();
		} else {
			logger.info(
				"Ollama manager instance not created (disabled in environment)",
			);
		}

		// Initialize environment
		this.initializeEnvironment().catch((error) => {
			logger.error("Environment initialization failed:", error);
			throw error;
		});

		// Add platform capabilities check in constructor
		this.checkPlatformCapabilities().catch((error) => {
			logger.warn("Platform capabilities check failed:", error);
		});

		// Add embedding initialization
		this.initializeEmbedding().catch((error) => {
			logger.warn("Embedding initialization failed:", error);
		});

		// Initialize models sequentially to avoid conflicts
		logger.info("Starting model initialization sequence");

		// First initialize the small model
		this.initialize(ModelTypes.TEXT_SMALL)
			.then(() => {
				logger.info(
					"Small model initialization complete, starting large model initialization",
				);
				// Then initialize the large model only after small model is done
				return this.initialize(ModelTypes.TEXT_LARGE);
			})
			.catch((error) => {
				logger.warn("Models initialization failed:", {
					stack: error instanceof Error ? error.stack : undefined,
					error: error instanceof Error ? error.message : String(error),
				});
			});

		// Initialize other services in parallel
		const servicePromises = [
			// Add vision initialization using a public method
			this.initializeVision().catch((error) => {
				logger.warn("Vision initialization failed:", error);
				return null; // Prevent Promise.all from failing completely
			}),
			// Add transcription initialization with better error handling
			this.initializeTranscription().catch((error) => {
				logger.warn("Transcription initialization failed:", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
				return null; // Prevent Promise.all from failing completely
			}),
			// Add TTS initialization
			this.initializeTTS().catch((error) => {
				logger.warn("TTS initialization failed:", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
				return null; // Prevent Promise.all from failing completely
			}),
		];

		// Only initialize StudioLM if enabled in environment and manager exists
		if (
			process.env.USE_STUDIOLM_TEXT_MODELS === "true" &&
			this.studioLMManager
		) {
			logger.info(
				"StudioLM initialization enabled by environment configuration",
			);
			servicePromises.push(
				this.initializeStudioLM()
					.then(() => {
						this.studioLMInitialized = true;
					})
					.catch((error) => {
						logger.warn("StudioLM initialization failed:", {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
						});
						return null; // Prevent Promise.all from failing completely
					}),
			);
		} else {
			logger.info(
				"StudioLM initialization skipped (disabled in environment configuration or manager not created)",
			);
		}

		// Only initialize Ollama if enabled in environment and manager exists
		if (process.env.USE_OLLAMA_TEXT_MODELS === "true" && this.ollamaManager) {
			logger.info("Ollama initialization enabled by environment configuration");
			servicePromises.push(
				this.initializeOllama()
					.then(() => {
						this.ollamaInitialized = true;
					})
					.catch((error) => {
						logger.warn("Ollama initialization failed:", {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
						});
						return null; // Prevent Promise.all from failing completely
					}),
			);
		} else {
			logger.info(
				"Ollama initialization skipped (disabled in environment configuration or manager not created)",
			);
		}

		Promise.all(servicePromises).catch((error) => {
			logger.warn("Models initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		});
	}

	/**
	 * Retrieves the singleton instance of LocalAIManager. If an instance does not already exist, a new one is created and returned.
	 * @returns {LocalAIManager} The singleton instance of LocalAIManager
	 */
	public static getInstance(): LocalAIManager {
		if (!LocalAIManager.instance) {
			LocalAIManager.instance = new LocalAIManager();
		}
		return LocalAIManager.instance;
	}

	/**
	 * Initializes the environment by validating the configuration and setting the environment variables with the validated values.
	 *
	 * @returns {Promise<void>} A Promise that resolves once the environment has been successfully initialized.
	 */
	private async initializeEnvironment(): Promise<void> {
		try {
			logger.info("Validating environment configuration...");

			// Create initial config from current env vars
			const config = {
				USE_LOCAL_AI: process.env.USE_LOCAL_AI,
				USE_STUDIOLM_TEXT_MODELS: process.env.USE_STUDIOLM_TEXT_MODELS,
				USE_OLLAMA_TEXT_MODELS: process.env.USE_OLLAMA_TEXT_MODELS,
			};

			// Validate configuration
			const validatedConfig = await validateConfig(config);

			// Log the validated configuration
			// logger.info("Environment configuration validated:", validatedConfig);
			logger.info("Environment configuration validated");

			// Ensure environment variables are set with validated values
			process.env.USE_LOCAL_AI = String(validatedConfig.USE_LOCAL_AI);
			process.env.USE_STUDIOLM_TEXT_MODELS = String(
				validatedConfig.USE_STUDIOLM_TEXT_MODELS,
			);
			process.env.USE_OLLAMA_TEXT_MODELS = String(
				validatedConfig.USE_OLLAMA_TEXT_MODELS,
			);

			// logger.info("Environment variables updated with validated values:", {
			//   USE_LOCAL_AI: process.env.USE_LOCAL_AI,
			//   USE_STUDIOLM_TEXT_MODELS: process.env.USE_STUDIOLM_TEXT_MODELS,
			//   USE_OLLAMA_TEXT_MODELS: process.env.USE_OLLAMA_TEXT_MODELS
			// });

			logger.success("Environment initialization complete");
		} catch (error) {
			logger.error("Environment validation failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	/**
	 * Asynchronously initializes the Ollama model.
	 *
	 * @returns {Promise<void>} A Promise that resolves when the initialization is complete.
	 * @throws {Error} If the Ollama manager is not created, or if initialization of Ollama models fails.
	 */
	private async initializeOllama(): Promise<void> {
		try {
			logger.info("Initializing Ollama models...");

			// Check if Ollama manager exists
			if (!this.ollamaManager) {
				throw new Error("Ollama manager not created - cannot initialize");
			}

			// Initialize and test models
			await this.ollamaManager.initialize();

			if (!this.ollamaManager.isInitialized()) {
				throw new Error(
					"Ollama initialization failed - models not properly loaded",
				);
			}

			logger.success("Ollama initialization complete");
		} catch (error) {
			logger.error("Ollama initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}

	/**
	 * Initializes StudioLM model with error handling.
	 * @returns A Promise that resolves when the initialization is complete.
	 * @throws {Error} If StudioLM manager is not created, initialization fails, or models are not properly loaded.
	 */
	private async initializeStudioLM(): Promise<void> {
		try {
			logger.info("Initializing StudioLM models...");

			// Check if StudioLM manager exists
			if (!this.studioLMManager) {
				throw new Error("StudioLM manager not created - cannot initialize");
			}

			// Initialize and test models
			await this.studioLMManager.initialize();

			if (!this.studioLMManager.isInitialized()) {
				throw new Error(
					"StudioLM initialization failed - models not properly loaded",
				);
			}

			this.studioLMInitialized = true;
			logger.success("StudioLM initialization complete");
		} catch (error) {
			logger.error("StudioLM initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}

	/**
	 * Asynchronously initializes the transcription model by performing the following steps:
	 * 1. Ensuring FFmpeg availability.
	 * 2. Defining sample file path and AWS URL.
	 * 3. Downloading the sample file if it doesn't exist in the cache.
	 * 4. Verifying the existence of the sample file and loading it.
	 * 5. Generating transcription result using the transcribeAudio method.
	 *
	 * @returns {Promise<void>} A Promise that resolves when the initialization process is complete or rejects with an error.
	 */
	private async initializeTranscription(): Promise<void> {
		try {
			logger.info("Initializing transcription model...");

			// First ensure FFmpeg is available
			const ffmpegAvailable = await this.transcribeManager.ensureFFmpeg();
			if (!ffmpegAvailable) {
				throw new Error(
					"Cannot initialize transcription without FFmpeg. Please install FFmpeg and try again.",
				);
			}

			// logger.info("FFmpeg initialized successfully:", {
			//   version: this.transcribeManager.getFFmpegVersion(),
			//   available: this.transcribeManager.isFFmpegAvailable(),
			//   timestamp: new Date().toISOString()
			// });

			// Define sample file path and AWS URL
			const samplePath = path.join(this.cacheDir, "sample1.wav");
			const awsSampleUrl =
				"https://d2908q01vomqb2.cloudfront.net/artifacts/DBSBlogs/ML-15311/sample1.wav?_=1";
			// Download sample file if it doesn't exist
			if (!fs.existsSync(samplePath)) {
				logger.info(
					"Sample WAV file not found in cache, downloading from AWS...",
				);
				try {
					await this.downloadManager.downloadFromUrl(awsSampleUrl, samplePath);
					logger.success("Sample WAV file downloaded successfully");
				} catch (downloadError) {
					logger.error("Failed to download sample WAV file:", {
						error:
							downloadError instanceof Error
								? downloadError.message
								: String(downloadError),
						url: awsSampleUrl,
						destination: samplePath,
						timestamp: new Date().toISOString(),
					});
					throw downloadError;
				}
			} else {
				logger.info("Sample WAV file already exists in cache");
			}

			// Verify file exists and load it
			if (!fs.existsSync(samplePath)) {
				throw new Error(
					`Sample audio file not found at: ${samplePath} after download attempt`,
				);
			}

			const testAudioBuffer = fs.readFileSync(samplePath);
			// logger.info("Sample audio file loaded:", {
			//   size: testAudioBuffer.length,
			//   path: samplePath,
			//   timestamp: new Date().toISOString()
			// });

			// Use our existing transcribeAudio method which uses transcribeManager
			const result = await this.transcribeAudio(testAudioBuffer);
			logger.info("Test transcription result:", {
				text: result,
				timestamp: new Date().toISOString(),
			});

			logger.success("Transcription model initialization complete");
		} catch (error) {
			logger.error("Transcription initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}

	/**
	 * Asynchronously initializes the vision by downloading a test image from AWS, processing it, and describing the image.
	 *
	 * @returns A Promise that resolves when the vision is successfully initialized
	 */
	private async initializeVision(): Promise<void> {
		try {
			logger.info("Initializing vision model...");

			// AWS test image URL
			const awsImageUrl =
				"https://d1.awsstatic.com/product-marketing/Rekognition/Image%20for%20facial%20analysis.3fcc22e8451b4a238540128cb5510b8cbe22da51.jpg";
			const imagePath = path.join(this.cacheDir, "test_image.jpg");

			// Download the test image if it doesn't exist
			if (!fs.existsSync(imagePath)) {
				logger.info("Downloading test image from AWS...");
				try {
					await this.downloadManager.downloadFromUrl(awsImageUrl, imagePath);
					logger.success("Test image downloaded successfully");
				} catch (downloadError) {
					logger.error("Failed to download test image:", {
						error:
							downloadError instanceof Error
								? downloadError.message
								: String(downloadError),
						url: awsImageUrl,
						destination: imagePath,
					});
					throw downloadError;
				}
			} else {
				logger.info("Test image already exists in cache");
			}

			// Verify file exists and load it
			if (!fs.existsSync(imagePath)) {
				throw new Error(
					`Test image not found at: ${imagePath} after download attempt`,
				);
			}

			const imageBuffer = fs.readFileSync(imagePath);

			// Process the test image
			const result = await this.describeImage(imageBuffer, "image/jpeg");
			logger.info("Test image description:", result);

			logger.success("Vision model initialization complete");
		} catch (error) {
			logger.error("Vision initialization failed:", error);
			throw error;
		}
	}

	/**
	 * Asynchronously initializes the Text-to-Speech (TTS) model by testing TTS with sample text,
	 * generating speech, and verifying the audio stream readability.
	 *
	 * @returns {Promise<void>} A Promise that resolves when the TTS model initialization is complete.
	 */
	private async initializeTTS(): Promise<void> {
		try {
			logger.info("Initializing TTS model...");

			// Test text for TTS
			const testText = "ElizaOS is yours";

			// Generate speech from test text
			logger.info("Testing TTS with sample text:", { text: testText });
			const audioStream = await this.ttsManager.generateSpeech(testText);

			// Verify the stream is readable
			if (!(audioStream instanceof Readable)) {
				throw new Error("TTS did not return a valid audio stream");
			}

			// Test stream readability
			let dataReceived = false;
			await new Promise<void>((resolve, reject) => {
				audioStream.on("data", () => {
					if (!dataReceived) {
						dataReceived = true;
						logger.info("TTS audio stream is producing data");
					}
				});

				audioStream.on("end", () => {
					if (!dataReceived) {
						reject(new Error("No audio data received from TTS stream"));
					} else {
						resolve();
					}
				});

				audioStream.on("error", (err) => {
					reject(err);
				});
			});

			logger.success("TTS model initialization complete");
		} catch (error) {
			logger.error("TTS initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}

	/**
	 * Downloads the model based on the modelPath provided.
	 * Determines whether to download a large or small model based on the current modelPath.
	 *
	 * @returns A Promise that resolves to a boolean indicating whether the model download was successful.
	 */
	private async downloadModel(): Promise<boolean> {
		try {
			// Determine which model to download based on current modelPath
			const isLargeModel = this.modelPath === this.mediumModelPath;
			const modelSpec = isLargeModel ? MODEL_SPECS.medium : MODEL_SPECS.small;
			return await this.downloadManager.downloadModel(
				modelSpec,
				this.modelPath,
			);
		} catch (error) {
			logger.error("Model download failed:", {
				error: error instanceof Error ? error.message : String(error),
				modelPath: this.modelPath,
			});
			throw error;
		}
	}

	/**
	 * Asynchronously checks the platform capabilities.
	 *
	 * @returns {Promise<void>} A promise that resolves once the platform capabilities have been checked.
	 */
	public async checkPlatformCapabilities(): Promise<void> {
		try {
			const platformManager = getPlatformManager();
			await platformManager.initialize();
			const capabilities = platformManager.getCapabilities();

			logger.info("Platform capabilities detected:", {
				platform: capabilities.platform,
				gpu: capabilities.gpu?.type || "none",
				recommendedModel: capabilities.recommendedModelSize,
				supportedBackends: capabilities.supportedBackends,
			});
		} catch (error) {
			logger.warn("Platform detection failed:", error);
		}
	}

	/**
	 * Initializes the LocalAI Manager for a given model type.
	 *
	 * @param {ModelType} modelType - The type of model to initialize (default: ModelTypes.TEXT_SMALL)
	 * @returns {Promise<void>} A promise that resolves when initialization is complete or rejects if an error occurs
	 */
	async initialize(
		modelType: ModelType = ModelTypes.TEXT_SMALL,
	): Promise<void> {
		try {
			logger.info("Initializing LocalAI Manager for model class:", modelType);

			// Set the correct model path based on the model class
			if (modelType === ModelTypes.TEXT_LARGE) {
				this.modelPath = this.mediumModelPath;
				logger.info("Using medium model path:", this.modelPath);
			} else {
				// Ensure we're using the small model path for small model
				this.modelPath = path.join(this.modelsDir, MODEL_SPECS.small.name);
				logger.info("Using small model path:", this.modelPath);
			}

			// Download the model and check if it was newly downloaded
			const wasNewlyDownloaded = await this.downloadModel();

			// Add a delay to ensure file system operations are complete if the model was newly downloaded
			if (wasNewlyDownloaded) {
				if (modelType === ModelTypes.TEXT_LARGE) {
					logger.info(
						"Adding delay before loading large model to ensure download is complete...",
					);
					await new Promise((resolve) => setTimeout(resolve, 10000)); // 60 second delay for large model
				} else {
					logger.info(
						"Adding delay before loading small model to ensure download is complete...",
					);
					await new Promise((resolve) => setTimeout(resolve, 10000)); // 15 second delay for small model
				}
			}

			// Verify the model file exists before trying to load it
			if (!fs.existsSync(this.modelPath)) {
				throw new Error(`Model file not found at path: ${this.modelPath}`);
			}

			this.llama = await getLlama();

			// Initialize the appropriate model
			if (modelType === ModelTypes.TEXT_LARGE) {
				this.activeModelConfig = MODEL_SPECS.medium;
				logger.info("Loading large model from:", this.modelPath);
				this.mediumModel = await this.llama.loadModel({
					modelPath: this.modelPath,
				});
				this.ctx = await this.mediumModel.createContext({
					contextSize: MODEL_SPECS.medium.contextSize,
				});
			} else {
				this.activeModelConfig = MODEL_SPECS.small;
				logger.info("Loading small model from:", this.modelPath);
				this.smallModel = await this.llama.loadModel({
					modelPath: this.modelPath,
				});
				this.ctx = await this.smallModel.createContext({
					contextSize: MODEL_SPECS.small.contextSize,
				});
			}

			if (!this.ctx) {
				throw new Error("Failed to create prompt");
			}

			this.sequence = this.ctx.getSequence();
			logger.success(
				`Model initialization complete for ${modelType === ModelTypes.TEXT_LARGE ? "large" : "small"} model`,
			);
		} catch (error) {
			logger.error("Initialization failed:", error);
			throw error;
		}
	}

	/**
	 * Asynchronously initializes the embedding model.
	 *
	 * @returns {Promise<void>} A promise that resolves once the initialization is complete.
	 */
	public async initializeEmbedding(): Promise<void> {
		try {
			logger.info("Initializing embedding model...");
			logger.info("Models directory:", this.modelsDir);

			// Ensure models directory exists
			if (!fs.existsSync(this.modelsDir)) {
				logger.warn(
					"Models directory does not exist, creating it:",
					this.modelsDir,
				);
				fs.mkdirSync(this.modelsDir, { recursive: true });
			}

			if (!this.embeddingModel) {
				logger.info(
					"Creating new FlagEmbedding instance with BGESmallENV15 model",
				);
				// logger.info("Embedding model download details:", {
				//   model: EmbeddingModel.BGESmallENV15,
				//   modelsDir: this.modelsDir,
				//   maxLength: 512,
				//   timestamp: new Date().toISOString()
				// });

				// Display initial progress bar
				const barLength = 30;
				const emptyBar = "▱".repeat(barLength);
				logger.info(`Downloading embedding model: ${emptyBar} 0%`);

				// Disable built-in progress bar and initialize the model
				this.embeddingModel = await FlagEmbedding.init({
					cacheDir: this.modelsDir,
					model: EmbeddingModel.BGESmallENV15,
					maxLength: 512,
					showDownloadProgress: false,
				});

				// Display completed progress bar
				const completedBar = "▰".repeat(barLength);
				logger.info(`Downloading embedding model: ${completedBar} 100%`);
				logger.success("FlagEmbedding instance created successfully");
			}

			// Verify the model is working with a test embedding
			logger.info("Testing embedding model with sample text...");
			const testEmbed = await this.embeddingModel.queryEmbed("test");
			logger.info(
				"Test embedding generated successfully, dimensions:",
				testEmbed.length,
			);

			logger.success("Embedding model initialization complete");
		} catch (error) {
			logger.error("Embedding initialization failed with details:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				modelsDir: this.modelsDir,
				model: EmbeddingModel.BGESmallENV15,
			});
			throw error;
		}
	}

	/**
	 * Asynchronously generates text using either StudioLM or Ollama models based on the specified parameters.
	 *
	 * @param {GenerateTextParams} params - The parameters for generating the text.
	 * @returns {Promise<string>} - A promise that resolves to the generated text.
	 */
	async generateTextOllamaStudio(params: GenerateTextParams): Promise<string> {
		try {
			const modelConfig = this.getTextModelSource();
			logger.info("generateTextOllamaStudio called with:", {
				modelSource: modelConfig.source,
				modelType: params.modelType,
				studioLMInitialized: this.studioLMInitialized,
				ollamaInitialized: this.ollamaInitialized,
				studioLMEnabled: process.env.USE_STUDIOLM_TEXT_MODELS === "true",
				ollamaEnabled: process.env.USE_OLLAMA_TEXT_MODELS === "true",
			});

			if (modelConfig.source === "studiolm") {
				// Check if StudioLM is enabled in environment
				if (process.env.USE_STUDIOLM_TEXT_MODELS !== "true") {
					logger.warn(
						"StudioLM requested but disabled in environment, falling back to local models",
					);
					return this.generateText(params);
				}

				// Check if StudioLM manager exists
				if (!this.studioLMManager) {
					logger.warn(
						"StudioLM manager not initialized, falling back to local models",
					);
					return this.generateText(params);
				}

				// Only initialize if not already initialized
				if (!this.studioLMInitialized) {
					logger.info("StudioLM not initialized, initializing now...");
					await this.initializeStudioLM();
				}

				// Pass initialization flag to generateText
				return await this.studioLMManager.generateText(
					params,
					this.studioLMInitialized,
				);
			}

			if (modelConfig.source === "ollama") {
				// Check if Ollama is enabled in environment
				if (process.env.USE_OLLAMA_TEXT_MODELS !== "true") {
					logger.warn(
						"Ollama requested but disabled in environment, falling back to local models",
					);
					return this.generateText(params);
				}

				// Check if Ollama manager exists
				if (!this.ollamaManager) {
					logger.warn(
						"Ollama manager not initialized, falling back to local models",
					);
					return this.generateText(params);
				}

				// Only initialize if not already initialized
				if (!this.ollamaInitialized && !this.ollamaManager.isInitialized()) {
					logger.info("Initializing Ollama in generateTextOllamaStudio");
					await this.ollamaManager.initialize();
					this.ollamaInitialized = true;
				}

				// Pass initialization flag to generateText
				return await this.ollamaManager.generateText(
					params,
					this.ollamaInitialized,
				);
			}

			// Fallback to local models if something goes wrong
			return this.generateText(params);
		} catch (error) {
			logger.error("Text generation with Ollama/StudioLM failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				modelSource: this.getTextModelSource().source,
			});
			// Fallback to local models
			return this.generateText(params);
		}
	}

	/**
	 * Asynchronously generates text based on the provided parameters.
	 *
	 * @param {GenerateTextParams} params - The parameters for text generation.
	 * @returns {Promise<string>} The generated text as a string.
	 */
	async generateText(params: GenerateTextParams): Promise<string> {
		try {
			// Initialize with the appropriate model class if not initialized
			if (
				!this.sequence ||
				!this.smallModel ||
				(params.modelType === ModelTypes.TEXT_LARGE && !this.mediumModel)
			) {
				await this.initialize(params.modelType);
			}

			// Select the appropriate model based on the model class
			let activeModel: LlamaModel;
			if (params.modelType === ModelTypes.TEXT_LARGE) {
				if (!this.mediumModel) {
					throw new Error("Medium model not initialized");
				}
				this.activeModelConfig = MODEL_SPECS.medium;
				activeModel = this.mediumModel;
				// QUICK TEST FIX: Always create fresh prompt
				this.ctx = await activeModel.createContext({
					contextSize: MODEL_SPECS.medium.contextSize,
				});
			} else {
				if (!this.smallModel) {
					throw new Error("Small model not initialized");
				}
				this.activeModelConfig = MODEL_SPECS.small;
				activeModel = this.smallModel;
				// QUICK TEST FIX: Always create fresh prompt
				this.ctx = await activeModel.createContext({
					contextSize: MODEL_SPECS.small.contextSize,
				});
			}

			if (!this.ctx) {
				throw new Error("Failed to create prompt");
			}

			// QUICK TEST FIX: Always get fresh sequence
			this.sequence = this.ctx.getSequence();

			// QUICK TEST FIX: Create new session each time without maintaining state
			// Only use valid options for LlamaChatSession
			this.chatSession = new LlamaChatSession({
				contextSequence: this.sequence,
			});

			if (!this.chatSession) {
				throw new Error("Failed to create chat session");
			}
			logger.info("Created new chat session for model:", params.modelType);
			// Log incoming prompt for debugging
			logger.info("Incoming prompt structure:", {
				contextLength: params.prompt.length,
				hasAction: params.prompt.includes("action"),
				runtime: !!params.runtime,
				stopSequences: params.stopSequences,
			});

			const tokens = await this.tokenizerManager.encode(
				params.prompt,
				this.activeModelConfig,
			);
			logger.info("Input tokens:", { count: tokens.length });

			// QUICK TEST FIX: Add system message to reset prompt
			const systemMessage =
				"You are a helpful AI assistant. Respond to the current request only.";
			await this.chatSession.prompt(systemMessage, {
				maxTokens: 1, // Minimal tokens for system message
				temperature: 0.0,
			});

			let response = await this.chatSession.prompt(params.prompt, {
				maxTokens: 8192,
				temperature: 0.7,
				topP: 0.9,
				repeatPenalty: {
					punishTokensFilter: () =>
						activeModel.tokenize(wordsToPunish.join(" ")),
					penalty: 1.2,
					frequencyPenalty: 0.7,
					presencePenalty: 0.7,
				},
			});

			// Log raw response for debugging
			logger.info("Raw response structure:", {
				responseLength: response.length,
				hasAction: response.includes("action"),
				hasThinkTag: response.includes("<think>"),
			});

			// Clean think tags if present
			if (response.includes("<think>")) {
				logger.info("Cleaning think tags from response");
				response = response.replace(/<think>[\s\S]*?<\/think>\n?/g, "");
				logger.info("Think tags removed from response");
			}

			// Return the raw response and let the framework handle JSON parsing and action validation
			return response;
		} catch (error) {
			logger.error("Text generation failed:", error);
			throw error;
		}
	}

	/**
	 * Asynchronously generates an embedding for the provided text.
	 *
	 * @param {string} text - The input text for which to generate the embedding
	 * @returns {Promise<number[]>} The generated embedding as an array of numbers
	 * @throws {Error} If the input text is null or undefined, or if there is an issue generating the embedding
	 */
	async generateEmbedding(text: string): Promise<number[]> {
		try {
			logger.info("Generating embedding...");
			// Add null check
			if (!text) {
				throw new Error("Input text cannot be null or undefined");
			}
			logger.debug("Input text length:", text.length);

			if (!this.embeddingModel) {
				logger.error(
					"Embedding model not initialized, attempting to initialize...",
				);
				await this.initializeEmbedding();
			}

			if (!this.embeddingModel) {
				throw new Error("Failed to initialize embedding model");
			}

			logger.info("Generating query embedding...");
			const embedding = await this.embeddingModel.queryEmbed(text);
			const dimensions = embedding.length;
			logger.info("Embedding generation complete", { dimensions });

			return Array.from(embedding);
		} catch (error) {
			logger.error("Embedding generation failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				// Only access text.length if text exists
				textLength: text?.length ?? "text is null",
			});
			throw error;
		}
	}

	/**
	 * Asynchronously describes the image based on the provided image data and MIME type.
	 * Converts the image data buffer to a data URL, then passes the URL to the VisionManager for processing.
	 *
	 * @param {Buffer} imageData The image data buffer to describe.
	 * @param {string} mimeType The MIME type of the image data.
	 * @returns {Promise<{ title: string; description: string }>} A Promise that resolves to an object containing the title and description of the described image.
	 * @throws {Error} If an error occurs during image description process.
	 */

	public async describeImage(
		imageData: Buffer,
		mimeType: string,
	): Promise<{ title: string; description: string }> {
		try {
			// Convert buffer to data URL
			const base64 = imageData.toString("base64");
			const dataUrl = `data:${mimeType};base64,${base64}`;
			return await this.visionManager.processImage(dataUrl);
		} catch (error) {
			logger.error("Image description failed:", error);
			throw error;
		}
	}

	/**
	 * Transcribe audio data from a Buffer.
	 *
	 * @param {Buffer} audioBuffer The audio data to transcribe
	 * @returns {Promise<string>} The transcribed text
	 * @throws {Error} If the audio transcription fails
	 */
	public async transcribeAudio(audioBuffer: Buffer): Promise<string> {
		try {
			const result = await this.transcribeManager.transcribe(audioBuffer);
			return result.text;
		} catch (error) {
			logger.error("Audio transcription failed:", {
				error: error instanceof Error ? error.message : String(error),
				bufferSize: audioBuffer.length,
			});
			throw error;
		}
	}

	/**
	 * Asynchronously generates speech for the given text using the TTS manager.
	 *
	 * @param {string} text - The text for which speech needs to be generated.
	 * @returns {Promise<Readable>} A Promise that resolves to a Readable stream containing the generated speech.
	 * @throws {Error} If speech generation fails, an error is thrown with details logged using the logger.
	 */
	public async generateSpeech(text: string): Promise<Readable> {
		try {
			return await this.ttsManager.generateSpeech(text);
		} catch (error) {
			logger.error("Speech generation failed:", {
				error: error instanceof Error ? error.message : String(error),
				textLength: text.length,
			});
			throw error;
		}
	}

	// Add public accessor methods
	/**
	 * Returns the TokenizerManager associated with this object.
	 *
	 * @returns {TokenizerManager} The TokenizerManager object.
	 */
	public getTokenizerManager(): TokenizerManager {
		return this.tokenizerManager;
	}

	/**
	 * Returns the active model configuration.
	 * @returns {ModelSpec} The active model configuration.
	 */
	public getActiveModelConfig(): ModelSpec {
		return this.activeModelConfig;
	}

	/**
	 * Retrieves the source configuration for the text model based on environment variables and manager existence.
	 * @returns {TextModelConfig} The configuration object containing the text model source and type.
	 */
	public getTextModelSource(): TextModelConfig {
		try {
			// Default configuration
			const config: TextModelConfig = {
				source: "local",
				modelType: ModelTypes.TEXT_SMALL,
			};

			// Check environment configuration and manager existence
			if (
				process.env.USE_STUDIOLM_TEXT_MODELS === "true" &&
				this.studioLMManager
			) {
				config.source = "studiolm";
			} else if (
				process.env.USE_OLLAMA_TEXT_MODELS === "true" &&
				this.ollamaManager
			) {
				config.source = "ollama";
			}

			logger.info("Selected text model source:", config);
			return config;
		} catch (error) {
			logger.error("Error determining text model source:", error);
			// Fallback to local models
			return { source: "local", modelType: ModelTypes.TEXT_SMALL };
		}
	}
}

// Create manager instance
const localAIManager = LocalAIManager.getInstance();

/**
 * Plugin that provides functionality for local AI using LLaMA models.
 * @type {Plugin}
 */
export const localAIPlugin: Plugin = {
	name: "local-ai",
	description: "Local AI plugin using LLaMA models",

	async init(config: Record<string, string>) {
		try {
			logger.info("Initializing local-ai plugin...");
			const validatedConfig = await validateConfig(config);

			// Set environment variables
			for (const [key, value] of Object.entries(validatedConfig)) {
				process.env[key] = String(value); // Convert boolean to string
				logger.debug(`Set ${key}=${value}`);
			}

			logger.success("Local AI plugin configuration validated and initialized");
		} catch (error) {
			logger.error("Plugin initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	},

	models: {
		[ModelTypes.TEXT_SMALL]: async (
			runtime: IAgentRuntime,
			{ prompt, stopSequences = [] }: GenerateTextParams,
		) => {
			try {
				const modelConfig = localAIManager.getTextModelSource();

				if (modelConfig.source !== "local") {
					return await localAIManager.generateTextOllamaStudio({
						prompt,
						stopSequences,
						runtime,
						modelType: ModelTypes.TEXT_SMALL,
					});
				}

				return await localAIManager.generateText({
					prompt,
					stopSequences,
					runtime,
					modelType: ModelTypes.TEXT_SMALL,
				});
			} catch (error) {
				logger.error("Error in TEXT_SMALL handler:", error);
				throw error;
			}
		},

		[ModelTypes.TEXT_LARGE]: async (
			runtime: IAgentRuntime,
			{ prompt, stopSequences = [] }: GenerateTextParams,
		) => {
			try {
				const modelConfig = localAIManager.getTextModelSource();

				if (modelConfig.source !== "local") {
					return await localAIManager.generateTextOllamaStudio({
						prompt,
						stopSequences,
						runtime,
						modelType: ModelTypes.TEXT_LARGE,
					});
				}

				return await localAIManager.generateText({
					prompt,
					stopSequences,
					runtime,
					modelType: ModelTypes.TEXT_LARGE,
				});
			} catch (error) {
				logger.error("Error in TEXT_LARGE handler:", error);
				throw error;
			}
		},

		[ModelTypes.TEXT_EMBEDDING]: async (
			_runtime: IAgentRuntime,
			text: string | null,
		) => {
			try {
				// Add detailed logging of the input text and its structure
				logger.info("TEXT_EMBEDDING handler - Initial input:", {
					text,
					// type: typeof text,
					// isString: typeof text === 'string',
					// isObject: typeof text === 'object',
					// hasThinkTag: typeof text === 'string' && text.includes('<think>'),
					length: text?.length,
					rawText: text, // Log the complete raw text
				});

				// If text is an object, log its structure
				if (typeof text === "object" && text !== null) {
					logger.info("TEXT_EMBEDDING handler - Object structure:", {
						keys: Object.keys(text),
						stringified: JSON.stringify(text, null, 2),
					});
				}

				// Handle null/undefined/empty text
				if (!text) {
					logger.warn("Null or empty text input for embedding");
					return new Array(384).fill(0);
				}

				// Pass the raw text directly to the framework without any manipulation
				return await localAIManager.generateEmbedding(text);
			} catch (error) {
				logger.error("Error in TEXT_EMBEDDING handler:", {
					error: error instanceof Error ? error.message : String(error),
					fullText: text,
					textType: typeof text,
					textStructure: text !== null ? JSON.stringify(text, null, 2) : "null",
				});
				return new Array(384).fill(0);
			}
		},

		[ModelTypes.TEXT_TOKENIZER_ENCODE]: async (
			_runtime: IAgentRuntime,
			{ text }: { text: string },
		) => {
			try {
				const manager = localAIManager.getTokenizerManager();
				const config = localAIManager.getActiveModelConfig();
				return await manager.encode(text, config);
			} catch (error) {
				logger.error("Error in TEXT_TOKENIZER_ENCODE handler:", error);
				throw error;
			}
		},

		[ModelTypes.TEXT_TOKENIZER_DECODE]: async (
			_runtime: IAgentRuntime,
			{ tokens }: { tokens: number[] },
		) => {
			try {
				const manager = localAIManager.getTokenizerManager();
				const config = localAIManager.getActiveModelConfig();
				return await manager.decode(tokens, config);
			} catch (error) {
				logger.error("Error in TEXT_TOKENIZER_DECODE handler:", error);
				throw error;
			}
		},

		[ModelTypes.IMAGE_DESCRIPTION]: async (
			_runtime: IAgentRuntime,
			imageUrl: string,
		) => {
			try {
				logger.info("Processing image from URL:", imageUrl);

				// Fetch the image from URL
				const response = await fetch(imageUrl);
				if (!response.ok) {
					throw new Error(`Failed to fetch image: ${response.statusText}`);
				}

				const buffer = Buffer.from(await response.arrayBuffer());
				const mimeType = response.headers.get("content-type") || "image/jpeg";

				return await localAIManager.describeImage(buffer, mimeType);
			} catch (error) {
				logger.error("Error in IMAGE_DESCRIPTION handler:", {
					error: error instanceof Error ? error.message : String(error),
					imageUrl,
				});
				throw error;
			}
		},

		[ModelTypes.TRANSCRIPTION]: async (
			_runtime: IAgentRuntime,
			audioBuffer: Buffer,
		) => {
			try {
				logger.info("Processing audio transcription:", {
					bufferSize: audioBuffer.length,
				});

				return await localAIManager.transcribeAudio(audioBuffer);
			} catch (error) {
				logger.error("Error in TRANSCRIPTION handler:", {
					error: error instanceof Error ? error.message : String(error),
					bufferSize: audioBuffer.length,
				});
				throw error;
			}
		},

		[ModelTypes.TEXT_TO_SPEECH]: async (
			_runtime: IAgentRuntime,
			text: string,
		) => {
			try {
				return await localAIManager.generateSpeech(text);
			} catch (error) {
				logger.error("Error in TEXT_TO_SPEECH handler:", {
					error: error instanceof Error ? error.message : String(error),
					textLength: text.length,
				});
				throw error;
			}
		},
	},
	tests: [
		{
			name: "local_ai_plugin_tests",
			tests: [
				{
					name: "local_ai_test_initialization",
					fn: async (runtime) => {
						try {
							logger.info("Starting initialization test");

							// Test TEXT_SMALL model initialization
							const result = await runtime.useModel(ModelTypes.TEXT_SMALL, {
								prompt:
									"Debug Mode: Test initialization. Respond with 'Initialization successful' if you can read this.",
								stopSequences: [],
							});

							logger.info("Model response:", result);

							if (!result || typeof result !== "string") {
								throw new Error("Invalid response from model");
							}

							if (!result.includes("successful")) {
								throw new Error("Model response does not indicate success");
							}

							logger.success("Initialization test completed successfully");
						} catch (error) {
							logger.error("Initialization test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_text_large",
					fn: async (runtime) => {
						try {
							logger.info("Starting TEXT_LARGE model test");

							const result = await runtime.useModel(ModelTypes.TEXT_LARGE, {
								prompt:
									"Debug Mode: Generate a one-sentence response about artificial intelligence.",
								stopSequences: [],
							});

							logger.info("Large model response:", result);

							if (!result || typeof result !== "string") {
								throw new Error("Invalid response from large model");
							}

							if (result.length < 10) {
								throw new Error("Response too short, possible model failure");
							}

							logger.success("TEXT_LARGE test completed successfully");
						} catch (error) {
							logger.error("TEXT_LARGE test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_text_embedding",
					fn: async (runtime) => {
						try {
							logger.info("Starting TEXT_EMBEDDING test");

							// Test with normal text
							const embedding = await runtime.useModel(
								ModelTypes.TEXT_EMBEDDING,
								"Test embedding generation",
							);

							logger.info(
								"Embedding generated with dimensions:",
								embedding.length,
							);

							if (!Array.isArray(embedding)) {
								throw new Error("Embedding is not an array");
							}

							if (embedding.length === 0) {
								throw new Error("Embedding array is empty");
							}

							if (embedding.some((val) => typeof val !== "number")) {
								throw new Error("Embedding contains non-numeric values");
							}

							// Test with null input (should return zero vector)
							const nullEmbedding = await runtime.useModel(
								ModelTypes.TEXT_EMBEDDING,
								null,
							);
							if (
								!Array.isArray(nullEmbedding) ||
								nullEmbedding.some((val) => val !== 0)
							) {
								throw new Error("Null input did not return zero vector");
							}

							logger.success("TEXT_EMBEDDING test completed successfully");
						} catch (error) {
							logger.error("TEXT_EMBEDDING test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_tokenizer_encode",
					fn: async (runtime) => {
						try {
							logger.info("Starting TEXT_TOKENIZER_ENCODE test");
							const text = "Hello tokenizer test!";

							const tokens = await runtime.useModel(
								ModelTypes.TEXT_TOKENIZER_ENCODE,
								{ text },
							);
							logger.info("Encoded tokens:", { count: tokens.length });

							if (!Array.isArray(tokens)) {
								throw new Error("Tokens output is not an array");
							}

							if (tokens.length === 0) {
								throw new Error("No tokens generated");
							}

							if (tokens.some((token) => !Number.isInteger(token))) {
								throw new Error("Tokens contain non-integer values");
							}

							logger.success(
								"TEXT_TOKENIZER_ENCODE test completed successfully",
							);
						} catch (error) {
							logger.error("TEXT_TOKENIZER_ENCODE test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_tokenizer_decode",
					fn: async (runtime) => {
						try {
							logger.info("Starting TEXT_TOKENIZER_DECODE test");

							// First encode some text
							const originalText = "Hello tokenizer test!";
							const tokens = await runtime.useModel(
								ModelTypes.TEXT_TOKENIZER_ENCODE,
								{ text: originalText },
							);

							// Then decode it back
							const decodedText = await runtime.useModel(
								ModelTypes.TEXT_TOKENIZER_DECODE,
								{ tokens },
							);
							logger.info("Round trip tokenization:", {
								original: originalText,
								decoded: decodedText,
							});

							if (typeof decodedText !== "string") {
								throw new Error("Decoded output is not a string");
							}

							logger.success(
								"TEXT_TOKENIZER_DECODE test completed successfully",
							);
						} catch (error) {
							logger.error("TEXT_TOKENIZER_DECODE test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_image_description",
					fn: async (runtime) => {
						try {
							logger.info("Starting IMAGE_DESCRIPTION test");

							const imageUrl =
								"https://raw.githubusercontent.com/microsoft/FLAML/main/website/static/img/flaml.png";
							const result = await runtime.useModel(
								ModelTypes.IMAGE_DESCRIPTION,
								imageUrl,
							);

							logger.info("Image description result:", result);

							if (!result || typeof result !== "object") {
								throw new Error("Invalid response format");
							}

							if (!result.title || !result.description) {
								throw new Error("Missing title or description in response");
							}

							if (
								typeof result.title !== "string" ||
								typeof result.description !== "string"
							) {
								throw new Error("Title or description is not a string");
							}

							logger.success("IMAGE_DESCRIPTION test completed successfully");
						} catch (error) {
							logger.error("IMAGE_DESCRIPTION test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_transcription",
					fn: async (runtime) => {
						try {
							logger.info("Starting TRANSCRIPTION test");

							// Create a simple audio buffer for testing
							const audioData = new Uint8Array([
								0x52,
								0x49,
								0x46,
								0x46, // "RIFF"
								0x24,
								0x00,
								0x00,
								0x00, // Chunk size
								0x57,
								0x41,
								0x56,
								0x45, // "WAVE"
								0x66,
								0x6d,
								0x74,
								0x20, // "fmt "
							]);
							const audioBuffer = Buffer.from(audioData);

							const transcription = await runtime.useModel(
								ModelTypes.TRANSCRIPTION,
								audioBuffer,
							);
							logger.info("Transcription result:", transcription);

							if (typeof transcription !== "string") {
								throw new Error("Transcription result is not a string");
							}

							logger.success("TRANSCRIPTION test completed successfully");
						} catch (error) {
							logger.error("TRANSCRIPTION test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_text_to_speech",
					fn: async (runtime) => {
						try {
							logger.info("Starting TEXT_TO_SPEECH test");

							const testText = "This is a test of the text to speech system.";
							const audioStream = await runtime.useModel(
								ModelTypes.TEXT_TO_SPEECH,
								testText,
							);

							if (!(audioStream instanceof Readable)) {
								throw new Error("TTS output is not a readable stream");
							}

							// Test stream readability
							let dataReceived = false;
							audioStream.on("data", () => {
								dataReceived = true;
							});

							await new Promise((resolve, reject) => {
								audioStream.on("end", () => {
									if (!dataReceived) {
										reject(new Error("No audio data received from stream"));
									} else {
										resolve(true);
									}
								});
								audioStream.on("error", reject);
							});

							logger.success("TEXT_TO_SPEECH test completed successfully");
						} catch (error) {
							logger.error("TEXT_TO_SPEECH test failed:", {
								error: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack : undefined,
							});
							throw error;
						}
					},
				},
			],
		},
	],
};

export default localAIPlugin;
