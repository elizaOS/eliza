import { logger, ModelTypes, type GenerateTextParams } from "@elizaos/core";
import fetch from "node-fetch";

interface StudioLMModel {
	id: string;
	object: string;
	created: number;
	owned_by: string;
}

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
}

interface ChatCompletionResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: {
		index: number;
		message: ChatMessage;
		finish_reason: string;
	}[];
}

export class StudioLMManager {
	private static instance: StudioLMManager | null = null;
	private serverUrl: string;
	private initialized = false;
	private availableModels: StudioLMModel[] = [];
	private configuredModels = {
		small:
			process.env.STUDIOLM_SMALL_MODEL ||
			"lmstudio-community/deepseek-r1-distill-qwen-1.5b",
		medium: process.env.STUDIOLM_MEDIUM_MODEL || "deepseek-r1-distill-qwen-7b",
	};

	private constructor() {
		this.serverUrl = process.env.STUDIOLM_SERVER_URL || "http://localhost:1234";
		logger.info("StudioLMManager initialized with configuration:", {
			serverUrl: this.serverUrl,
			configuredModels: this.configuredModels,
			timestamp: new Date().toISOString(),
		});
	}

	public static getInstance(): StudioLMManager {
		if (!StudioLMManager.instance) {
			StudioLMManager.instance = new StudioLMManager();
		}
		return StudioLMManager.instance;
	}

	private async checkServerStatus(): Promise<boolean> {
		try {
			const response = await fetch(`${this.serverUrl}/v1/models`);
			if (!response.ok) {
				throw new Error(`Server responded with status: ${response.status}`);
			}
			return true;
		} catch (error) {
			logger.error("LM Studio server check failed:", {
				error: error instanceof Error ? error.message : String(error),
				serverUrl: this.serverUrl,
				timestamp: new Date().toISOString(),
			});
			return false;
		}
	}

	private async fetchAvailableModels(): Promise<void> {
		try {
			const response = await fetch(`${this.serverUrl}/v1/models`);
			if (!response.ok) {
				throw new Error(`Failed to fetch models: ${response.status}`);
			}

			const data = (await response.json()) as { data: StudioLMModel[] };
			this.availableModels = data.data;

			logger.info("LM Studio available models:", {
				count: this.availableModels.length,
				models: this.availableModels.map((m) => m.id),
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			logger.error("Failed to fetch LM Studio models:", {
				error: error instanceof Error ? error.message : String(error),
				serverUrl: this.serverUrl,
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}

	private async testModel(modelId: string): Promise<boolean> {
		try {
			const testRequest: ChatCompletionRequest = {
				model: modelId,
				messages: [
					{
						role: "system",
						content: "Always answer in rhymes. Today is Thursday",
					},
					{ role: "user", content: "What day is it today?" },
				],
				temperature: 0.7,
				max_tokens: -1,
				stream: false,
			};

			logger.info(`Testing model ${modelId}...`);

			const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(testRequest),
			});

			if (!response.ok) {
				throw new Error(`Model test failed with status: ${response.status}`);
			}

			const result = (await response.json()) as ChatCompletionResponse;

			if (!result.choices?.[0]?.message?.content) {
				throw new Error("No valid response content received");
			}

			logger.info(`Model ${modelId} test response:`, {
				content: result.choices[0].message.content,
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
				logger.info("StudioLM already initialized, skipping initialization");
				return;
			}

			logger.info("Starting StudioLM initialization...");
			const serverAvailable = await this.checkServerStatus();

			if (!serverAvailable) {
				throw new Error("LM Studio server is not available");
			}

			await this.fetchAvailableModels();
			await this.testTextModels();

			this.initialized = true;
			logger.success("StudioLM initialization complete");
		} catch (error) {
			logger.error("StudioLM initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	public getAvailableModels(): StudioLMModel[] {
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
			logger.info("StudioLM generateText entry:", {
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
					"StudioLM not initialized. Please initialize before generating text.",
				);
			}

			const messages: ChatMessage[] = [
				{
					role: "system",
					content:
						"You are a helpful AI assistant. Respond to the current request only.",
				},
				{ role: "user", content: params.prompt },
			];

			logger.info("StudioLM preparing request:", {
				model:
					params.modelType === ModelTypes.TEXT_LARGE
						? this.configuredModels.medium
						: this.configuredModels.small,
				messageCount: messages.length,
				timestamp: new Date().toISOString(),
			});

			logger.info("Incoming context structure:", {
				contextLength: params.prompt.length,
				hasAction: params.prompt.includes("action"),
				runtime: !!params.runtime,
				stopSequences: params.stopSequences,
			});

			const request: ChatCompletionRequest = {
				model:
					params.modelType === ModelTypes.TEXT_LARGE
						? this.configuredModels.medium
						: this.configuredModels.small,
				messages,
				temperature: 0.7,
				max_tokens: 8192,
				stream: false,
			};

			const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(request),
			});

			if (!response.ok) {
				throw new Error(`StudioLM request failed: ${response.status}`);
			}

			const result = (await response.json()) as ChatCompletionResponse;

			if (!result.choices?.[0]?.message?.content) {
				throw new Error("No valid response content received from StudioLM");
			}

			let responseText = result.choices[0].message.content;

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

			logger.info("StudioLM request completed successfully:", {
				responseLength: responseText.length,
				hasThinkTags: responseText.includes("<think>"),
				timestamp: new Date().toISOString(),
			});

			return responseText;
		} catch (error) {
			logger.error("StudioLM text generation error:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				phase: "text generation",
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}
}
