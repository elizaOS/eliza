import { logger } from "@elizaos/core";
import {
	AutoProcessor,
	AutoTokenizer,
	env,
	Florence2ForConditionalGeneration,
	type Florence2Processor,
	type PreTrainedTokenizer,
	RawImage,
	type Tensor,
	type PreTrainedModel,
	type ProgressCallback,
	type ProgressInfo,
} from "@huggingface/transformers";
import { existsSync } from "node:fs";
import { MODEL_SPECS } from "../types";
import { DownloadManager } from "./downloadManager";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";

// Define valid types based on HF transformers types
type DeviceType = "cpu" | "gpu" | "auto";
type DTypeType = "fp32" | "fp16" | "auto";

interface PlatformConfig {
	device: DeviceType;
	dtype: DTypeType;
	useOnnx: boolean;
}

interface ModelComponent {
	name: string;
	type: string;
	dtype?: DTypeType;
}

export class VisionManager {
	private static instance: VisionManager | null = null;
	private model: Florence2ForConditionalGeneration | null = null;
	private processor: Florence2Processor | null = null;
	private tokenizer: PreTrainedTokenizer | null = null;
	private modelsDir: string;
	private cacheDir: string;
	private initialized = false;
	private downloadManager: DownloadManager;
	private modelDownloaded = false;
	private tokenizerDownloaded = false;
	private processorDownloaded = false;
	private platformConfig: PlatformConfig;
	private modelComponents: ModelComponent[] = [
		{ name: "embed_tokens", type: "embeddings" },
		{ name: "vision_encoder", type: "encoder" },
		{ name: "decoder_model_merged", type: "decoder" },
		{ name: "encoder_model", type: "encoder" },
	];

	private constructor(cacheDir: string) {
		this.modelsDir = path.join(path.dirname(cacheDir), "models", "vision");
		this.cacheDir = cacheDir;
		this.ensureModelsDirExists();
		this.downloadManager = DownloadManager.getInstance(
			this.cacheDir,
			this.modelsDir,
		);
		this.platformConfig = this.getPlatformConfig();
		logger.info("VisionManager initialized");
		// logger.info("VisionManager initialized with configuration:", {
		//   modelsDir: this.modelsDir,
		//   exists: existsSync(this.modelsDir),
		//   platform: this.platformConfig
		// });
	}

	private getPlatformConfig(): PlatformConfig {
		const platform = os.platform();
		const arch = os.arch();

		// Default configuration
		let config: PlatformConfig = {
			device: "cpu",
			dtype: "fp32",
			useOnnx: true,
		};

		if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) {
			// Apple Silicon
			config = {
				device: "gpu",
				dtype: "fp16",
				useOnnx: true,
			};
		} else if (platform === "win32" || platform === "linux") {
			// Windows or Linux with CUDA
			const hasCuda = process.env.CUDA_VISIBLE_DEVICES !== undefined;
			if (hasCuda) {
				config = {
					device: "gpu",
					dtype: "fp16",
					useOnnx: true,
				};
			}
		}

		logger.info("Platform configuration detected:", {
			platform,
			arch,
			config,
		});

		return config;
	}

	private ensureModelsDirExists(): void {
		if (!existsSync(this.modelsDir)) {
			logger.info(`Creating models directory at: ${this.modelsDir}`);
			fs.mkdirSync(this.modelsDir, { recursive: true });
		}
	}

	public static getInstance(cacheDir: string): VisionManager {
		if (!VisionManager.instance) {
			VisionManager.instance = new VisionManager(cacheDir);
		}
		return VisionManager.instance;
	}

	private checkCacheExists(
		modelId: string,
		type: "model" | "tokenizer" | "processor",
	): boolean {
		const modelPath = path.join(
			this.modelsDir,
			modelId.replace("/", "--"),
			type,
		);
		if (existsSync(modelPath)) {
			logger.info(`${type} found at: ${modelPath}`);
			return true;
		}
		return false;
	}

	private configureModelComponents(): void {
		const platform = os.platform();
		const arch = os.arch();

		// Set dtype based on platform capabilities
		let defaultDtype: DTypeType = "fp32";

		if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) {
			// Apple Silicon can handle fp16
			defaultDtype = "fp16";
		} else if (
			(platform === "win32" || platform === "linux") &&
			process.env.CUDA_VISIBLE_DEVICES !== undefined
		) {
			// CUDA-enabled systems can handle fp16
			defaultDtype = "fp16";
		}

		// Update all component dtypes
		this.modelComponents = this.modelComponents.map((component) => ({
			...component,
			dtype: defaultDtype,
		}));

		logger.info("Model components configured with dtype:", {
			platform,
			arch,
			defaultDtype,
			components: this.modelComponents.map((c) => `${c.name}: ${c.dtype}`),
		});
	}

	private getModelConfig(componentName: string) {
		const component = this.modelComponents.find(
			(c) => c.name === componentName,
		);
		return {
			device: this.platformConfig.device,
			dtype: component?.dtype || "fp32",
			cache_dir: this.modelsDir,
		};
	}

	private async initialize() {
		try {
			if (this.initialized) {
				logger.info(
					"Vision model already initialized, skipping initialization",
				);
				return;
			}

			logger.info("Starting vision model initialization...");
			const modelSpec = MODEL_SPECS.vision;

			// Configure environment
			logger.info("Configuring environment for vision model...");
			env.allowLocalModels = true;
			env.allowRemoteModels = true;

			// Configure ONNX backend
			if (this.platformConfig.useOnnx) {
				env.backends.onnx.enabled = true;
				env.backends.onnx.logLevel = "info";
			}

			// logger.info("Vision model configuration:", {
			//   modelId: modelSpec.modelId,
			//   modelsDir: this.modelsDir,
			//   allowLocalModels: env.allowLocalModels,
			//   allowRemoteModels: env.allowRemoteModels,
			//   platform: this.platformConfig
			// });

			// Initialize model with detailed logging
			logger.info("Loading Florence2 model...");
			try {
				let lastProgress = -1;
				const modelCached = this.checkCacheExists(modelSpec.modelId, "model");

				const model = await Florence2ForConditionalGeneration.from_pretrained(
					modelSpec.modelId,
					{
						device: "cpu",
						cache_dir: this.modelsDir,
						local_files_only: modelCached,
						revision: "main",
						progress_callback: ((progressInfo: ProgressInfo) => {
							if (modelCached || this.modelDownloaded) return;
							const progress =
								"progress" in progressInfo
									? Math.max(0, Math.min(1, progressInfo.progress))
									: 0;
							const currentProgress = Math.round(progress * 100);
							if (
								currentProgress > lastProgress + 9 ||
								currentProgress === 100
							) {
								lastProgress = currentProgress;
								const barLength = 30;
								const filledLength = Math.floor(
									(currentProgress / 100) * barLength,
								);
								const progressBar =
									"▰".repeat(filledLength) +
									"▱".repeat(barLength - filledLength);
								logger.info(
									`Downloading vision model: ${progressBar} ${currentProgress}%`,
								);
								if (currentProgress === 100) this.modelDownloaded = true;
							}
						}) as ProgressCallback,
					},
				);

				this.model = model as unknown as Florence2ForConditionalGeneration;
				logger.success("Florence2 model loaded successfully");
			} catch (error) {
				logger.error("Failed to load Florence2 model:", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					modelId: modelSpec.modelId,
				});
				throw error;
			}

			// Initialize tokenizer with detailed logging
			logger.info("Loading vision tokenizer...");
			try {
				const tokenizerCached = this.checkCacheExists(
					modelSpec.modelId,
					"tokenizer",
				);
				let tokenizerProgress = -1;

				this.tokenizer = await AutoTokenizer.from_pretrained(
					modelSpec.modelId,
					{
						cache_dir: this.modelsDir,
						local_files_only: tokenizerCached,
						progress_callback: ((progressInfo: ProgressInfo) => {
							if (tokenizerCached || this.tokenizerDownloaded) return;
							const progress =
								"progress" in progressInfo
									? Math.max(0, Math.min(1, progressInfo.progress))
									: 0;
							const currentProgress = Math.round(progress * 100);
							if (currentProgress !== tokenizerProgress) {
								tokenizerProgress = currentProgress;
								const barLength = 30;
								const filledLength = Math.floor(
									(currentProgress / 100) * barLength,
								);
								const progressBar =
									"▰".repeat(filledLength) +
									"▱".repeat(barLength - filledLength);
								logger.info(
									`Downloading vision tokenizer: ${progressBar} ${currentProgress}%`,
								);
								if (currentProgress === 100) this.tokenizerDownloaded = true;
							}
						}) as ProgressCallback,
					},
				);
				logger.success("Vision tokenizer loaded successfully");
			} catch (error) {
				logger.error("Failed to load tokenizer:", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					modelId: modelSpec.modelId,
				});
				throw error;
			}

			// Initialize processor with detailed logging
			logger.info("Loading vision processor...");
			try {
				const processorCached = this.checkCacheExists(
					modelSpec.modelId,
					"processor",
				);
				let processorProgress = -1;

				this.processor = (await AutoProcessor.from_pretrained(
					modelSpec.modelId,
					{
						device: "cpu",
						cache_dir: this.modelsDir,
						local_files_only: processorCached,
						progress_callback: ((progressInfo: ProgressInfo) => {
							if (processorCached || this.processorDownloaded) return;
							const progress =
								"progress" in progressInfo
									? Math.max(0, Math.min(1, progressInfo.progress))
									: 0;
							const currentProgress = Math.round(progress * 100);
							if (currentProgress !== processorProgress) {
								processorProgress = currentProgress;
								const barLength = 30;
								const filledLength = Math.floor(
									(currentProgress / 100) * barLength,
								);
								const progressBar =
									"▰".repeat(filledLength) +
									"▱".repeat(barLength - filledLength);
								logger.info(
									`Downloading vision processor: ${progressBar} ${currentProgress}%`,
								);
								if (currentProgress === 100) this.processorDownloaded = true;
							}
						}) as ProgressCallback,
					},
				)) as Florence2Processor;
				logger.success("Vision processor loaded successfully");
			} catch (error) {
				logger.error("Failed to load vision processor:", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					modelId: modelSpec.modelId,
				});
				throw error;
			}

			this.initialized = true;
			logger.success("Vision model initialization complete");
		} catch (error) {
			logger.error("Vision model initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				modelsDir: this.modelsDir,
			});
			throw error;
		}
	}

	private async fetchImage(
		url: string,
	): Promise<{ buffer: Buffer; mimeType: string }> {
		try {
			logger.info(`Fetching image from URL: ${url.slice(0, 100)}...`);

			// Handle data URLs differently
			if (url.startsWith("data:")) {
				logger.info("Processing data URL...");
				const [header, base64Data] = url.split(",");
				const mimeType = header.split(";")[0].split(":")[1];
				const buffer = Buffer.from(base64Data, "base64");
				logger.info("Data URL processed successfully");
				// logger.info("Data URL processed successfully:", {
				//   mimeType,
				//   bufferSize: buffer.length
				// });
				return { buffer, mimeType };
			}

			// Handle regular URLs
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Failed to fetch image: ${response.statusText}`);
			}
			const buffer = Buffer.from(await response.arrayBuffer());
			const mimeType = response.headers.get("content-type") || "image/jpeg";

			logger.info("Image fetched successfully:", {
				mimeType,
				bufferSize: buffer.length,
				status: response.status,
			});

			return { buffer, mimeType };
		} catch (error) {
			logger.error("Failed to fetch image:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				url,
			});
			throw error;
		}
	}

	public async processImage(
		imageUrl: string,
	): Promise<{ title: string; description: string }> {
		try {
			logger.info("Starting image processing...");

			// Ensure model is initialized
			if (!this.initialized) {
				logger.info("Vision model not initialized, initializing now...");
				await this.initialize();
			}

			if (!this.model || !this.processor || !this.tokenizer) {
				throw new Error("Vision model components not properly initialized");
			}

			// Fetch and process image
			logger.info("Fetching image...");
			const { buffer, mimeType } = await this.fetchImage(imageUrl);

			// Process image
			logger.info("Creating image blob...");
			const blob = new Blob([buffer], { type: mimeType });
			logger.info("Converting blob to RawImage...");
			// @ts-ignore - RawImage.fromBlob expects web Blob but works with node Blob
			const image = await RawImage.fromBlob(blob);

			logger.info("Processing image with vision processor...");
			const visionInputs = await this.processor(image);
			logger.info("Constructing prompts...");
			const prompts = this.processor.construct_prompts("<DETAILED_CAPTION>");
			logger.info("Tokenizing prompts...");
			const textInputs = this.tokenizer(prompts);

			// Generate description
			logger.info("Generating image description...");
			const generatedIds = (await this.model.generate({
				...textInputs,
				...visionInputs,
				max_new_tokens: MODEL_SPECS.vision.maxTokens,
			})) as Tensor;

			logger.info("Decoding generated text...");
			const generatedText = this.tokenizer.batch_decode(generatedIds, {
				skip_special_tokens: false,
			})[0];

			logger.info("Post-processing generation...");
			const result = this.processor.post_process_generation(
				generatedText,
				"<DETAILED_CAPTION>",
				image.size,
			);

			const detailedCaption = result["<DETAILED_CAPTION>"] as string;
			const response = {
				title: `${detailedCaption.split(".")[0]}.`,
				description: detailedCaption,
			};

			logger.success("Image processing complete:", {
				titleLength: response.title.length,
				descriptionLength: response.description.length,
			});

			return response;
		} catch (error) {
			logger.error("Image processing failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				imageUrl,
				modelInitialized: this.initialized,
				hasModel: !!this.model,
				hasProcessor: !!this.processor,
				hasTokenizer: !!this.tokenizer,
			});
			throw error;
		}
	}
}
