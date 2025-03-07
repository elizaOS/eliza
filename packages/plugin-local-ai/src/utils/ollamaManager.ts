import { logger, ModelTypes, type GenerateTextParams } from "@elizaos/core";

import fetch from "node-fetch";

interface OllamaModel {
	name: string;
	id: string;
	size: string;
	modified: string;
}

interface OllamaResponse {
	model: string;
	response: string;
	done: boolean;
	prompt?: number[];
	total_duration?: number;
	load_duration?: number;
	prompt_eval_duration?: number;
	eval_duration?: number;
}

export class OllamaManager {
	private static instance: OllamaManager | null = null;
	private serverUrl: string;
	private initialized = false;
	private availableModels: OllamaModel[] = [];
	private configuredModels = {
		small: process.env.SMALL_OLLAMA_MODEL || "deepseek-r1:1.5b",
		medium: process.env.MEDIUM_OLLAMA_MODEL || "deepseek-r1:7b",
	};

	private constructor() {
		this.serverUrl = process.env.OLLAMA_SERVER_URL || "http://localhost:11434";
		logger.info("OllamaManager initialized with configuration:", {
			serverUrl: this.serverUrl,
			configuredModels: this.configuredModels,
			timestamp: new Date().toISOString(),
		});
	}

	public static getInstance(): OllamaManager {
		if (!OllamaManager.instance) {
			OllamaManager.instance = new OllamaManager();
		}
		return OllamaManager.instance;
	}

	private async checkServerStatus(): Promise<boolean> {
		try {
			const response = await fetch(`${this.serverUrl}/api/tags`);
			if (!response.ok) {
				throw new Error(`Server responded with status: ${response.status}`);
			}
			return true;
		} catch (error) {
			logger.error("Ollama server check failed:", {
				error: error instanceof Error ? error.message : String(error),
				serverUrl: this.serverUrl,
				timestamp: new Date().toISOString(),
			});
			return false;
		}
	}

	private async fetchAvailableModels(): Promise<void> {
		try {
			const response = await fetch(`${this.serverUrl}/api/tags`);
			if (!response.ok) {
				throw new Error(`Failed to fetch models: ${response.status}`);
			}

			const data = (await response.json()) as { models: OllamaModel[] };
			this.availableModels = data.models;

			logger.info("Ollama available models:", {
				count: this.availableModels.length,
				models: this.availableModels.map((m) => m.name),
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			logger.error("Failed to fetch Ollama models:", {
				error: error instanceof Error ? error.message : String(error),
				serverUrl: this.serverUrl,
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}

	private async testModel(modelId: string): Promise<boolean> {
		try {
			const testRequest = {
				model: modelId,
				prompt:
					"Debug Mode: Test initialization. Respond with 'Initialization successful' if you can read this.",
				stream: false,
				options: {
					temperature: 0.7,
					num_predict: 100,
				},
			};

			logger.info(`Testing model ${modelId}...`);

			const response = await fetch(`${this.serverUrl}/api/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(testRequest),
			});

			if (!response.ok) {
				throw new Error(`Model test failed with status: ${response.status}`);
			}

			const result = (await response.json()) as OllamaResponse;

			if (!result.response) {
				throw new Error("No valid response content received");
			}

			logger.info(`Model ${modelId} test response:`, {
				content: result.response,
				model: result.model,
				timestamp: new Date().toISOString(),
			});

			return true;
		} catch (error) {
			logger.error(`Model ${modelId} test failed:`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString(),
			});
			return false;
		}
	}

	private async testTextModels(): Promise<void> {
		logger.info("Testing configured text models...");

		const results = await Promise.all([
			this.testModel(this.configuredModels.small),
			this.testModel(this.configuredModels.medium),
		]);

		const [smallWorking, mediumWorking] = results;

		if (!smallWorking || !mediumWorking) {
			const failedModels = [];
			if (!smallWorking) failedModels.push("small");
			if (!mediumWorking) failedModels.push("medium");

			logger.warn("Some models failed the test:", {
				failedModels,
				small: this.configuredModels.small,
				medium: this.configuredModels.medium,
			});
		} else {
			logger.success("All configured models passed the test");
		}
	}

	public async initialize(): Promise<void> {
		try {
			if (this.initialized) {
				logger.info("Ollama already initialized, skipping initialization");
				return;
			}

			logger.info("Starting Ollama initialization...");
			const serverAvailable = await this.checkServerStatus();

			if (!serverAvailable) {
				throw new Error("Ollama server is not available");
			}

			await this.fetchAvailableModels();
			await this.testTextModels();

			this.initialized = true;
			logger.success("Ollama initialization complete");
		} catch (error) {
			logger.error("Ollama initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	public getAvailableModels(): OllamaModel[] {
		return this.availableModels;
	}

	public isInitialized(): boolean {
		return this.initialized;
	}

	public async generateText(
		params: GenerateTextParams,
		isInitialized = false,
	): Promise<string> {
		try {
			// Log entry point with all parameters
			logger.info("Ollama generateText entry:", {
				isInitialized,
				currentInitState: this.initialized,
				managerInitState: this.isInitialized(),
				modelType: params.modelType,
				contextLength: params.prompt?.length,
				timestamp: new Date().toISOString(),
			});

			// Only initialize if not already initialized and not marked as initialized
			if (!this.initialized && !isInitialized) {
				throw new Error(
					"Ollama not initialized. Please initialize before generating text.",
				);
			}

			logger.info("Ollama preparing request:", {
				model:
					params.modelType === ModelTypes.TEXT_LARGE
						? this.configuredModels.medium
						: this.configuredModels.small,
				contextLength: params.prompt.length,
				timestamp: new Date().toISOString(),
			});

			const request = {
				model:
					params.modelType === ModelTypes.TEXT_LARGE
						? this.configuredModels.medium
						: this.configuredModels.small,
				prompt: params.prompt,
				stream: false,
				options: {
					temperature: 0.7,
					top_p: 0.9,
					num_predict: 8192,
					repeat_penalty: 1.2,
					frequency_penalty: 0.7,
					presence_penalty: 0.7,
				},
			};

			const response = await fetch(`${this.serverUrl}/api/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(request),
			});

			if (!response.ok) {
				throw new Error(`Ollama request failed: ${response.status}`);
			}

			const result = (await response.json()) as OllamaResponse;

			if (!result.response) {
				throw new Error("No valid response content received from Ollama");
			}

			let responseText = result.response;

			// Log raw response for debugging
			logger.info("Raw response structure:", {
				responseLength: responseText.length,
				hasAction: responseText.includes("action"),
				hasThinkTag: responseText.includes("<think>"),
			});

			// Clean think tags if present
			if (responseText.includes("<think>")) {
				logger.info("Cleaning think tags from response");
				responseText = responseText.replace(/<think>[\s\S]*?<\/think>\n?/g, "");
				logger.info("Think tags removed from response");
			}

			logger.info("Ollama request completed successfully:", {
				responseLength: responseText.length,
				hasThinkTags: responseText.includes("<think>"),
				timestamp: new Date().toISOString(),
			});

			return responseText;
		} catch (error) {
			logger.error("Ollama text generation error:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				phase: "text generation",
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}
}
