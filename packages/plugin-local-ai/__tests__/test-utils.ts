import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
	type Character,
	type IAgentRuntime,
	type IDatabaseAdapter,
	type IMemoryManager,
	type ModelType,
	ModelTypes,
	type State,
	logger,
} from "@elizaos/core";
import { vi } from "vitest";
import { MODEL_SPECS } from "../src/types";

// Get the workspace root by going up from the current file location
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../");

// During tests, we need to set cwd to agent directory since that's where the plugin runs from in production
const AGENT_DIR = path.join(WORKSPACE_ROOT, "packages/agent");
process.chdir(AGENT_DIR);

// Create shared mock for download manager
export const downloadModelMock = vi.fn().mockResolvedValue(undefined);

export const TEST_PATHS = {
	MODELS_DIR: path.join(AGENT_DIR, "models"),
	CACHE_DIR: path.join(AGENT_DIR, "cache"),
} as const;

export const createMockRuntime = (): IAgentRuntime => ({
	agentId: "12345678-1234-1234-1234-123456789012",
	databaseAdapter: {} as IDatabaseAdapter,
	character: {} as Character,
	providers: [],
	actions: [],
	evaluators: [],
	plugins: [],
	fetch: null,
	routes: [],
	getService: () => null,
	getAllServices: () => new Map(),
	initialize: async () => {},
	getMemoryManager: () => null,
	registerService: () => {},
	setSetting: () => {},
	getSetting: () => null,
	getConversationLength: () => 0,
	processActions: async () => {},
	evaluate: async () => null,
	registerProvider: () => {},
	registerAction: () => {},
	ensureConnection: async () => {},
	ensureParticipantInRoom: async () => {},
	ensureRoomExists: async () => {},
	composeState: async () => ({}) as State,
	useModel: async <T>(
		modelType: ModelType,
		params: T,
	): Promise<string | Readable> => {
		// Check if there are any pending mock rejections
		const mockCalls = downloadModelMock.mock.calls;
		if (
			mockCalls.length > 0 &&
			downloadModelMock.mock.results[mockCalls.length - 1].type === "throw"
		) {
			// Rethrow the error from the mock
			throw downloadModelMock.mock.results[mockCalls.length - 1].value;
		}

		// Call downloadModel based on the model class
		if (modelType === ModelTypes.TEXT_SMALL) {
			await downloadModelMock(
				MODEL_SPECS.small,
				path.join(TEST_PATHS.MODELS_DIR, MODEL_SPECS.small.name),
			);
			return "This is a test response from the small model.";
		}
		if (modelType === ModelTypes.TEXT_LARGE) {
			await downloadModelMock(
				MODEL_SPECS.medium,
				path.join(TEST_PATHS.MODELS_DIR, MODEL_SPECS.medium.name),
			);
			return "Artificial intelligence is a transformative technology that continues to evolve.";
		}
		if (modelType === ModelTypes.TRANSCRIPTION) {
			// For transcription, we expect a Buffer as the parameter
			const audioBuffer = params as unknown as Buffer;
			if (!Buffer.isBuffer(audioBuffer)) {
				throw new Error("Invalid audio buffer");
			}
			if (audioBuffer.length === 0) {
				throw new Error("Empty audio buffer");
			}

			// Mock the transcription process
			const { nodewhisper } = await import("nodejs-whisper");
			const { exec } = await import("node:child_process");

			// Create a temporary file path for testing
			const tempPath = path.join(
				TEST_PATHS.CACHE_DIR,
				"whisper",
				`temp_${Date.now()}.wav`,
			);

			// Mock the file system operations
			if (!fs.existsSync(path.dirname(tempPath))) {
				fs.mkdirSync(path.dirname(tempPath), { recursive: true });
			}
			fs.writeFileSync(tempPath, audioBuffer);

			try {
				// Call the mocked exec for audio conversion
				await new Promise((resolve, reject) => {
					exec(
						`ffmpeg -y -i "${tempPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${tempPath}"`,
						(error, stdout, stderr) => {
							if (error) reject(error);
							else resolve({ stdout, stderr });
						},
					);
				});

				// Call the mocked whisper for transcription
				const result = await nodewhisper(tempPath, {
					modelName: "base.en",
					autoDownloadModelName: "base.en",
				});

				// Clean up
				if (fs.existsSync(tempPath)) {
					fs.unlinkSync(tempPath);
				}

				return result;
			} catch (error) {
				// Clean up on error
				if (fs.existsSync(tempPath)) {
					fs.unlinkSync(tempPath);
				}
				throw error;
			}
		}
		if (modelType === ModelTypes.IMAGE_DESCRIPTION) {
			// For image description, we expect a URL as the parameter
			const imageUrl = params as unknown as string;
			if (typeof imageUrl !== "string") {
				throw new Error("Invalid image URL");
			}

			try {
				logger.info("Attempting to fetch image:", imageUrl);

				// Mock the fetch and vision processing
				const response = await fetch(imageUrl);
				logger.info("Fetch response:", {
					status: response.status,
					statusText: response.statusText,
					contentType: response.headers.get("content-type"),
					ok: response.ok,
				});

				if (!response.ok) {
					const error = new Error(
						`Failed to fetch image: ${response.statusText}`,
					);
					logger.error("Fetch failed:", {
						error: error.message,
						status: response.status,
						statusText: response.statusText,
					});
					throw error;
				}

				// Import and initialize vision model
				const { Florence2ForConditionalGeneration } = await import(
					"@huggingface/transformers"
				);
				try {
					await Florence2ForConditionalGeneration.from_pretrained("mock-model");
				} catch (error) {
					logger.error("Vision model initialization failed:", error);
					throw new Error("Vision model failed to load");
				}

				// For successful responses, return mock description
				const mockResult = {
					title: "A test image from Picsum",
					description:
						"This is a detailed description of a randomly generated test image from Picsum Photos, showing various visual elements in high quality.",
				};
				logger.info("Generated mock description:", mockResult);

				return JSON.stringify(mockResult);
			} catch (error) {
				logger.error("Image description failed:", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					imageUrl,
				});
				throw error;
			}
		}
		if (modelType === ModelTypes.TEXT_TO_SPEECH) {
			// For TTS, we expect a string as the parameter
			const text = params as unknown as string;
			if (typeof text !== "string") {
				throw new Error("invalid input: expected string");
			}
			if (text.length === 0) {
				throw new Error("empty text input");
			}

			try {
				logger.info("Processing TTS request:", { textLength: text.length });

				// Get the mock implementation to check for errors
				const { getLlama } = await import("node-llama-cpp");
				const llamaMock = vi.mocked(getLlama);

				// Call getLlama to trigger any mock rejections
				// We don't need to pass actual arguments since we're just testing error handling
				await llamaMock("lastBuild");

				// Create a mock audio stream
				const mockAudioStream = new Readable({
					read() {
						// Push some mock audio data
						this.push(
							Buffer.from([
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
							]),
						);
						this.push(null); // End of stream
					},
				});

				logger.success("TTS generation successful");
				return mockAudioStream;
			} catch (error) {
				logger.error("TTS generation failed:", {
					error: error instanceof Error ? error.message : String(error),
					textLength: text.length,
				});
				throw error;
			}
		}
		throw new Error(`Unexpected model class: ${modelType}`);
	},
	registerModel: () => {},
	getModel: () => undefined,
	registerEvent: () => {},
	getEvent: () => undefined,
	emitEvent: () => {},
	createTask: () => "12345678-1234-1234-1234-123456789012",
	getTasks: () => undefined,
	getTask: () => undefined,
	updateTask: () => {},
	deleteTask: () => {},
	stop: async () => {},
});
