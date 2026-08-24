/**
 * Unit tests for Ollama provider: validates handler registration dictionary.
 */
import { describe, expect, it } from "vitest";
import { ModelType } from "../types";
import {
	createOllamaModelHandlers,
	isOllamaAvailable,
} from "./ollama-provider.ts";

describe("ollama-provider", () => {
	it("creates model handlers for text and embedding types", () => {
		const handlers = createOllamaModelHandlers();
		expect(handlers[ModelType.TEXT_SMALL]).toBeDefined();
		expect(handlers[ModelType.TEXT_LARGE]).toBeDefined();
		expect(handlers[ModelType.TEXT_EMBEDDING]).toBeDefined();
	});

	it("returns boolean for isOllamaAvailable check", async () => {
		const available = await isOllamaAvailable();
		expect(typeof available).toBe("boolean");
	});
});
