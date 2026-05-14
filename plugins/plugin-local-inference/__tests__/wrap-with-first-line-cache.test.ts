import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { FIRST_SENTENCE_SNIP_VERSION } from "@elizaos/shared";
import {
	fingerprintVoiceSettings,
	FirstLineCache,
	type FirstLineCacheKey,
} from "../src/services/voice/first-line-cache";
import {
	type TtsHandler,
	type TtsResolvedContext,
	wrapWithFirstLineCache,
} from "../src/services/voice/wrap-with-first-line-cache";

let tmpRoot: string;

function makeCache(disabled = false): FirstLineCache {
	return new FirstLineCache({ rootDir: tmpRoot, disabled });
}

function makeRuntime(): IAgentRuntime {
	return {} as IAgentRuntime;
}

function ctxFor(over: Partial<TtsResolvedContext> = {}): TtsResolvedContext {
	return {
		provider: "elevenlabs",
		voiceId: "EXAVITQu4vr4xnSDxMaL",
		voiceRevision: "rev-test",
		codec: "mp3",
		contentType: "audio/mpeg",
		sampleRate: 44100,
		voiceSettingsFingerprint: fingerprintVoiceSettings({}),
		...over,
	};
}

function bytesOfLen(n: number, fill = 0x11): Uint8Array {
	const b = new Uint8Array(n);
	b.fill(fill);
	return b;
}

beforeEach(() => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "fl-wrap-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("wrapWithFirstLineCache — short-circuit conditions", () => {
	it("falls through when cache is disabled", async () => {
		const cache = makeCache(true);
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(8));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor(),
		});
		const out = await wrapped(makeRuntime(), { text: "Got it." });
		expect(inner).toHaveBeenCalledTimes(1);
		expect((out as Uint8Array).length).toBe(8);
	});

	it("falls through on empty text", async () => {
		const cache = makeCache();
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(8));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor(),
		});
		await wrapped(makeRuntime(), { text: "" });
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("falls through when no first sentence can be snipped", async () => {
		const cache = makeCache();
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(8));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor(),
		});
		await wrapped(makeRuntime(), { text: "no terminator here" });
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("falls through when resolveContext returns bypass", async () => {
		const cache = makeCache();
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(8));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor({ bypass: true }),
		});
		await wrapped(makeRuntime(), { text: "Got it." });
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("falls through when resolveContext returns null", async () => {
		const cache = makeCache();
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(8));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => null,
		});
		await wrapped(makeRuntime(), { text: "Got it." });
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("falls through when voiceRevision is empty", async () => {
		const cache = makeCache();
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(8));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor({ voiceRevision: "" }),
		});
		await wrapped(makeRuntime(), { text: "Got it." });
		expect(inner).toHaveBeenCalledTimes(1);
	});
});

describe("wrapWithFirstLineCache — miss path populates the cache", () => {
	it("calls inner once for the full input on miss, then schedules populate", async () => {
		const cache = makeCache();
		const fullBytes = bytesOfLen(64, 0x42);
		const snipBytes = bytesOfLen(32, 0x77);
		const inner = vi.fn<TtsHandler>(async (_runtime, input) => {
			const text = typeof input === "string" ? input : input.text;
			if (text === "Got it.") return snipBytes;
			return fullBytes;
		});
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor(),
		});
		const out = await wrapped(makeRuntime(), {
			text: "Got it. Here is the rest of the message.",
		});
		expect((out as Uint8Array)).toEqual(fullBytes);
		expect(inner).toHaveBeenCalledTimes(1);
		// Allow the background populate to run.
		await new Promise((r) => setTimeout(r, 25));
		// Second call (background populate of just the snip).
		expect(inner.mock.calls.length).toBeGreaterThanOrEqual(2);

		const key: FirstLineCacheKey = {
			algoVersion: FIRST_SENTENCE_SNIP_VERSION,
			provider: "elevenlabs",
			voiceId: "EXAVITQu4vr4xnSDxMaL",
			voiceRevision: "rev-test",
			sampleRate: 44100,
			codec: "mp3",
			voiceSettingsFingerprint: fingerprintVoiceSettings({}),
			normalizedText: "got it",
		};
		expect(cache.has(key)).toBe(true);
	});
});

describe("wrapWithFirstLineCache — hit path concat", () => {
	it("returns cached bytes alone when snip == whole input", async () => {
		const cache = makeCache();
		const cached = bytesOfLen(20, 0x33);
		const key: FirstLineCacheKey = {
			algoVersion: FIRST_SENTENCE_SNIP_VERSION,
			provider: "elevenlabs",
			voiceId: "EXAVITQu4vr4xnSDxMaL",
			voiceRevision: "rev-test",
			sampleRate: 44100,
			codec: "mp3",
			voiceSettingsFingerprint: fingerprintVoiceSettings({}),
			normalizedText: "got it",
		};
		cache.put({
			...key,
			bytes: cached,
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(8));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor(),
		});
		const out = await wrapped(makeRuntime(), { text: "Got it." });
		// Cached returned exactly; inner not called.
		expect(out).toEqual(cached);
		expect(inner).not.toHaveBeenCalled();
	});

	it("concatenates cached bytes with synthesized remainder (mp3)", async () => {
		const cache = makeCache();
		const cachedBytes = bytesOfLen(16, 0xaa);
		const remainderBytes = bytesOfLen(24, 0xbb);
		const key: FirstLineCacheKey = {
			algoVersion: FIRST_SENTENCE_SNIP_VERSION,
			provider: "elevenlabs",
			voiceId: "EXAVITQu4vr4xnSDxMaL",
			voiceRevision: "rev-test",
			sampleRate: 44100,
			codec: "mp3",
			voiceSettingsFingerprint: fingerprintVoiceSettings({}),
			normalizedText: "got it",
		};
		cache.put({
			...key,
			bytes: cachedBytes,
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		const inner = vi.fn<TtsHandler>(async () => remainderBytes);
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () => ctxFor(),
		});
		const out = (await wrapped(makeRuntime(), {
			text: "Got it. Here is the rest.",
		})) as Uint8Array;
		expect(out.length).toBe(cachedBytes.length + remainderBytes.length);
		expect(out[0]).toBe(0xaa);
		expect(out[cachedBytes.length]).toBe(0xbb);
		// Inner called once for the remainder synthesis.
		expect(inner).toHaveBeenCalledTimes(1);
		// And the input it received should be the remainder, not the full text.
		const lastCall = inner.mock.calls[inner.mock.calls.length - 1];
		const lastInput = lastCall ? lastCall[1] : "";
		const remainderText =
			typeof lastInput === "string" ? lastInput : (lastInput?.text ?? "");
		expect(remainderText.includes("Got it")).toBe(false);
		expect(remainderText.startsWith("Here is the rest")).toBe(true);
	});

	it("falls back to inner on a hit when codec is non-concat-safe (wav)", async () => {
		const cache = makeCache();
		const cachedBytes = bytesOfLen(16, 0xcc);
		const key: FirstLineCacheKey = {
			algoVersion: FIRST_SENTENCE_SNIP_VERSION,
			provider: "local",
			voiceId: "default",
			voiceRevision: "rev-wav",
			sampleRate: 24000,
			codec: "wav",
			voiceSettingsFingerprint: fingerprintVoiceSettings({}),
			normalizedText: "got it",
		};
		cache.put({
			...key,
			bytes: cachedBytes,
			rawText: "Got it.",
			contentType: "audio/wav",
			durationMs: 0,
		});
		const inner = vi.fn<TtsHandler>(async () => bytesOfLen(96, 0x99));
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () =>
				ctxFor({
					provider: "local",
					voiceId: "default",
					voiceRevision: "rev-wav",
					sampleRate: 24000,
					codec: "wav",
					contentType: "audio/wav",
				}),
		});
		const out = (await wrapped(makeRuntime(), {
			text: "Got it. And more.",
		})) as Uint8Array;
		// Concat disabled for wav → falls back to full synth.
		expect(out.length).toBe(96);
		expect(inner).toHaveBeenCalledTimes(1);
	});
});

describe("wrapWithFirstLineCache — F3 voice-swap regression", () => {
	it("Kokoro-cached opener does NOT play through ElevenLabs key", async () => {
		const cache = makeCache();
		const kokoroBytes = bytesOfLen(32, 0x77);
		// Populate cache as Kokoro.
		cache.put({
			algoVersion: FIRST_SENTENCE_SNIP_VERSION,
			provider: "kokoro",
			voiceId: "af_bella",
			voiceRevision: "kokoro-rev-1",
			sampleRate: 24000,
			codec: "opus",
			voiceSettingsFingerprint: fingerprintVoiceSettings({}),
			normalizedText: "got it",
			bytes: kokoroBytes,
			rawText: "Got it.",
			contentType: "audio/opus",
			durationMs: 0,
		});

		const elevenBytes = bytesOfLen(64, 0xee);
		const inner = vi.fn<TtsHandler>(async () => elevenBytes);
		// Now wrap an ElevenLabs handler.
		const wrapped = wrapWithFirstLineCache(inner, {
			cache,
			resolveContext: () =>
				ctxFor({
					provider: "elevenlabs",
					voiceId: "EXAVITQu4vr4xnSDxMaL",
					voiceRevision: "eleven-rev-1",
				}),
		});
		const out = await wrapped(makeRuntime(), { text: "Got it." });
		// Must NOT return the Kokoro cached bytes.
		expect(out).not.toEqual(kokoroBytes);
		expect(out).toEqual(elevenBytes);
	});
});
