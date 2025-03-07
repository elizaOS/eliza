import { describe, test, expect } from "vitest";
import { ModelClass } from "@elizaos/core";
import { localAIPlugin } from "../src/index";

describe("LocalAI Plugin Initialization", () => {
	test("should initialize plugin with default configuration", async () => {
		// Mock runtime for testing
		const mockRuntime = {
			useModel: async (modelClass: ModelClass, _params: any) => {
				if (modelClass === ModelClass.TEXT_SMALL) {
					return "Initialization successful";
				}
				throw new Error(`Unexpected model class: ${modelClass}`);
			},
		};

		try {
			// Initialize plugin
			await localAIPlugin.init({});

			// Run initialization test
			const result = await mockRuntime.useModel(ModelClass.TEXT_SMALL, {
				context:
					"Debug Mode: Test initialization. Respond with 'Initialization successful' if you can read this.",
				stopSequences: [],
			});

			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
			expect(result).toContain("successful");
		} catch (error) {
			console.error("Test failed:", error);
			throw error;
		}
	});

	test("should initialize with custom model path", async () => {
		const customConfig = {
			LLAMALOCAL_PATH: "./custom/models",
			CACHE_DIR: "./custom/cache",
		};

		try {
			await localAIPlugin.init(customConfig);
			expect(process.env.LLAMALOCAL_PATH).toBe(customConfig.LLAMALOCAL_PATH);
			expect(process.env.CACHE_DIR).toBe(customConfig.CACHE_DIR);
		} catch (error) {
			console.error("Test failed:", error);
			throw error;
		}
	});

	test("should handle invalid configuration", async () => {
		const invalidConfig = {
			LLAMALOCAL_PATH: 123, // Invalid type
		};

		await expect(localAIPlugin.init(invalidConfig as any)).rejects.toThrow();
	});
});
