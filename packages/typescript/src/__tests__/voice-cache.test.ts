import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceCacheService } from "../services/voice-cache";
import type { IAgentRuntime } from "../types";

describe("VoiceCacheService", () => {
	const runtime = {
		character: {
			name: "test-character",
			settings: { voice: { model: "en_US-male-medium" } },
		},
	} as unknown as IAgentRuntime;

	let service: VoiceCacheService;

	beforeEach(async () => {
		service = new VoiceCacheService();
		await service.initialize(runtime);
	});

	afterEach(() => {
		// cleanup
		const cacheDir = path.join(
			process.cwd(),
			"cache",
			"voice",
			"test-character",
		);
		if (fs.existsSync(cacheDir)) {
			fs.rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("should generate consistent keys", () => {
		const text = "Hello world";
		const key1 = service.generateKey(text, "default", "model1");
		const key2 = service.generateKey(text, "default", "model1");
		expect(key1).toBe(key2);
	});

	it("should cache and retrieve audio", () => {
		const text = "Cache me";
		const key = service.generateKey(text, "v1", "m1");
		const audio = Buffer.from("fake-audio-data");

		service.setCached(key, audio);

		const cached = service.getCached(key);
		expect(cached).toBeDefined();
		expect(cached?.equals(audio)).toBe(true);
	});

	it("should return null for missing cache", () => {
		const key = "non-existent";
		const cached = service.getCached(key);
		expect(cached).toBeNull();
	});
});
