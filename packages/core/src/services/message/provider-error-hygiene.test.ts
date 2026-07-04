import { describe, expect, it } from "vitest";
import { type Memory, ModelType } from "../../types";
import { shouldSkipResponseMemoryPersistence } from "../message";
import {
	isModelProviderFallbackError,
	isRateLimitError,
} from "./fallback-reply";

function assistantMemory(
	text: string,
	content: Record<string, unknown> = {},
): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
		entityId:
			"00000000-0000-0000-0000-000000000002" as `${string}-${string}-${string}-${string}-${string}`,
		agentId:
			"00000000-0000-0000-0000-000000000002" as `${string}-${string}-${string}-${string}-${string}`,
		roomId:
			"00000000-0000-0000-0000-000000000003" as `${string}-${string}-${string}-${string}-${string}`,
		content: { text, ...content },
		createdAt: Date.now(),
	};
}

describe("provider error hygiene", () => {
	it("classifies Anthropic 529 overloaded errors as failover-eligible and retryable", () => {
		const error = Object.assign(
			new Error("API Error: 529 Overloaded. This is a server-side issue."),
			{ statusCode: 529 },
		);

		expect(isModelProviderFallbackError(error)).toBe(true);
		expect(isRateLimitError(error)).toBe(true);
	});

	it("never marks TEXT_TO_SPEECH errors as failover-eligible (voice fails closed #12253)", () => {
		// "fetch failed" (Kokoro model-download failure) matches the transient
		// heuristic for text slots, but a voice swap is not transient-recoverable.
		const kokoroDownloadError = new Error("fetch failed");
		expect(isModelProviderFallbackError(kokoroDownloadError)).toBe(true);
		expect(
			isModelProviderFallbackError(
				kokoroDownloadError,
				ModelType.TEXT_TO_SPEECH,
			),
		).toBe(false);
		// A genuine 5xx from a TTS provider is likewise not a swap trigger.
		const serviceError = Object.assign(new Error("service unavailable"), {
			statusCode: 503,
		});
		expect(
			isModelProviderFallbackError(serviceError, ModelType.TEXT_TO_SPEECH),
		).toBe(false);
	});

	it("marks transient failure replies as non-persisted response memories", () => {
		const memory = assistantMemory(
			"Something went wrong on my end. Please try again.",
			{
				failureKind: "transient_failure",
				elizaSyntheticFailure: true,
				transient: true,
				doNotPersist: true,
			},
		);

		expect(shouldSkipResponseMemoryPersistence(memory)).toBe(true);
	});

	it("does not skip ordinary assistant replies", () => {
		const memory = assistantMemory("normal answer");
		expect(shouldSkipResponseMemoryPersistence(memory)).toBe(false);
	});
});
