/**
 * Unit tests for model failure classification, error diagnostics, and fallback prompt generation.
 */

import { describe, expect, it } from "vitest";
import { TrajectoryLimitExceeded } from "../../runtime/limits.js";
import { ModelType } from "../../types/model.js";
import {
	buildFailureReplyPrompt,
	classifyStructuredFailureCause,
	describeModelCallError,
	isAuthError,
	isInsufficientCreditsError,
	isModelProviderFallbackError,
	isRateLimitError,
	stripReasoningBlocks,
} from "./fallback-reply.js";

describe("fallback-reply", () => {
	describe("error diagnostics & classification", () => {
		it("describes model call errors accurately with HTTP status and message", () => {
			const errWithStatus = {
				statusCode: 429,
				error: { message: "Too many requests to OpenAI" },
			};
			expect(describeModelCallError(errWithStatus)).toBe(
				"HTTP 429: Too many requests to OpenAI",
			);

			const plainErr = new Error("Connection reset by peer");
			expect(describeModelCallError(plainErr)).toBe("Connection reset by peer");
		});

		it("identifies rate limit errors by HTTP 429 and common message patterns", () => {
			expect(isRateLimitError({ statusCode: 429 })).toBe(true);
			expect(
				isRateLimitError(new Error("Rate limit exceeded for organization")),
			).toBe(true);
			expect(
				isRateLimitError(new Error("Requests per minute quota reached")),
			).toBe(true);
			expect(isRateLimitError(new Error("Internal error"))).toBe(false);
		});

		it("identifies insufficient credits / quota exhaustion errors", () => {
			expect(isInsufficientCreditsError({ statusCode: 402 })).toBe(true);
			expect(
				isInsufficientCreditsError({
					error: { type: "insufficient_quota" },
				}),
			).toBe(true);
			expect(
				isInsufficientCreditsError(
					new Error("You exceeded your current quota, please check your plan"),
				),
			).toBe(true);
		});

		it("identifies authentication and authorization errors (401/403)", () => {
			expect(isAuthError({ statusCode: 401 })).toBe(true);
			expect(isAuthError({ statusCode: 403 })).toBe(true);
			expect(isAuthError(new Error("Invalid API key provided"))).toBe(true);
			expect(isAuthError(new Error("Unauthorized"))).toBe(true);
		});

		it("identifies retryable/fallback errors while respecting TTS modelType constraints", () => {
			expect(isModelProviderFallbackError({ statusCode: 503 })).toBe(true);
			expect(isModelProviderFallbackError(new Error("Gateway timeout"))).toBe(
				true,
			);
			// TTS models fail closed and never rotate
			expect(
				isModelProviderFallbackError(
					{ statusCode: 503 },
					ModelType.TEXT_TO_SPEECH,
				),
			).toBe(false);
		});

		it("classifies structured failure causes from trajectory limit errors", () => {
			const toolLimit = new TrajectoryLimitExceeded({
				kind: "unavailable_tool_calls",
				max: 1,
				observed: 2,
			});
			expect(classifyStructuredFailureCause(toolLimit)).toBe(
				"missing_capability",
			);

			const missLimit = new TrajectoryLimitExceeded({
				kind: "required_tool_misses",
				max: 3,
				observed: 4,
			});
			expect(classifyStructuredFailureCause(missLimit)).toBe(
				"planner_exhaustion",
			);

			expect(classifyStructuredFailureCause(new Error("generic"))).toBe(
				"transient",
			);
		});
	});

	describe("buildFailureReplyPrompt", () => {
		it("builds actionable failure reply prompt with hard rules and recent conversation", () => {
			const prompt = buildFailureReplyPrompt(
				"User: Help me\nAgent: Thinking...",
				"missing_capability",
			);
			expect(prompt).toContain("Recent Conversation:");
			expect(prompt).toContain("User: Help me");
			expect(prompt).toContain("Hard rules:");
			expect(prompt).toContain("Do NOT claim it was done");
		});
	});

	describe("stripReasoningBlocks", () => {
		it("strips think/reasoning tag blocks and trailing artifacts", () => {
			const raw =
				"<think>Let me evaluate this user request.</think>Here is the response.";
			expect(stripReasoningBlocks(raw)).toBe("Here is the response.");

			const rawWithNoThink = "no_think Final text";
			expect(stripReasoningBlocks(rawWithNoThink)).toBe("Final text");
		});
	});
});
