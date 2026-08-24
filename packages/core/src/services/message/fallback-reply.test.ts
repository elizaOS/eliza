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

	describe("describeModelCallError unwrapping and serialization", () => {
		it("unwraps the AI SDK retry envelope carried on lastError", () => {
			expect(
				describeModelCallError({
					lastError: { statusCode: 503, error: { message: "upstream down" } },
				}),
			).toBe("HTTP 503: upstream down");
		});

		it("unwraps the last entry of an errors array envelope", () => {
			expect(
				describeModelCallError({
					errors: [
						{ statusCode: 500, error: { message: "first attempt" } },
						{ statusCode: 502, error: { message: "final attempt" } },
					],
				}),
			).toBe("HTTP 502: final attempt");
		});

		it("prefers the unwrapped status over the outer envelope status", () => {
			const outerThrottled = {
				statusCode: 429,
				lastError: { statusCode: 402 },
			};
			expect(describeModelCallError(outerThrottled)).toBe("HTTP 402");
		});

		it("falls back to the original error's message when the unwrap carries none", () => {
			expect(
				describeModelCallError({
					lastError: { statusCode: 500 },
					error: { message: "outer provider context" },
				}),
			).toBe("HTTP 500: outer provider context");
		});

		it("renders a status-only failure without a message", () => {
			expect(describeModelCallError({ statusCode: 429 })).toBe("HTTP 429");
		});

		it("serializes a bare payload that has no status or message", () => {
			expect(describeModelCallError({ code: "ECONNRESET" })).toBe(
				'{"code":"ECONNRESET"}',
			);
		});

		it("never stringifies an empty object as the diagnostic line", () => {
			expect(describeModelCallError({})).toBe("[object Object]");
			expect(describeModelCallError(new Error(""))).toBe("Error");
		});

		it("survives a non-serializable circular payload via String()", () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(describeModelCallError(circular)).toBe("[object Object]");
		});
	});

	describe("rate-limit classification edge inputs", () => {
		it("reads the structured 429 through the retry envelope and legacy .status duck type", () => {
			expect(isRateLimitError({ lastError: { statusCode: 429 } })).toBe(true);
			expect(isRateLimitError({ status: 429 })).toBe(true);
		});

		it("matches credit-exhaustion session phrases as rate limits", () => {
			expect(isRateLimitError(new Error("you've hit your usage limit"))).toBe(
				true,
			);
			expect(isRateLimitError(new Error("Session limit reached"))).toBe(true);
			expect(
				isRateLimitError(new Error("provider is overloaded, slow down")),
			).toBe(true);
		});

		it("matches bare status tokens in message text", () => {
			expect(isRateLimitError(new Error("request failed with HTTP 429"))).toBe(
				true,
			);
			expect(isRateLimitError(new Error("anthropic returned a 529"))).toBe(
				true,
			);
		});

		it("does not classify non-Error values even when they mention rate limits", () => {
			expect(
				isRateLimitError({ code: "X", message: "rate limit exceeded" }),
			).toBe(false);
			expect(isRateLimitError("rate limit exceeded")).toBe(false);
		});
	});

	describe("insufficient-credits classification edge inputs", () => {
		it("classifies plain strings through the same message scanner", () => {
			expect(isInsufficientCreditsError("out of credits")).toBe(true);
			expect(isInsufficientCreditsError("max usage reached")).toBe(true);
			expect(isInsufficientCreditsError("payment required by provider")).toBe(
				true,
			);
			expect(isInsufficientCreditsError("rate limit exceeded")).toBe(false);
		});

		it("reads an insufficient-credits code from the structured error body", () => {
			expect(
				isInsufficientCreditsError({ error: { code: "insufficient_quota" } }),
			).toBe(true);
			expect(
				isInsufficientCreditsError({ error: { code: "insufficient_funds" } }),
			).toBe(true);
		});

		it("treats a throttled 429 with billing context as credit exhaustion but a bare one as rate limiting", () => {
			const billingThrottle = new Error(
				"quota exceeded while throttled",
			) as Error & {
				statusCode?: number;
			};
			billingThrottle.statusCode = 429;
			expect(isInsufficientCreditsError(billingThrottle)).toBe(true);

			const plainThrottle = new Error("too many requests") as Error & {
				statusCode?: number;
			};
			plainThrottle.statusCode = 429;
			expect(isInsufficientCreditsError(plainThrottle)).toBe(false);
			expect(isRateLimitError(plainThrottle)).toBe(true);
		});
	});

	describe("auth-error classification edge inputs", () => {
		it("reads 401/403 through the retry envelope", () => {
			expect(isAuthError({ lastError: { statusCode: 401 } })).toBe(true);
			expect(isAuthError({ lastError: { statusCode: 403 } })).toBe(true);
		});

		it("matches auth substrings and bare status tokens in message text", () => {
			expect(isAuthError(new Error("authentication failed for key"))).toBe(
				true,
			);
			expect(isAuthError(new Error("expired api key"))).toBe(true);
			expect(
				isAuthError(new Error("authentication_required by provider")),
			).toBe(true);
			expect(isAuthError(new Error("request rejected with 403"))).toBe(true);
		});

		it("does not classify other statuses as auth failures", () => {
			expect(isAuthError({ statusCode: 402 })).toBe(false);
			expect(isAuthError({ statusCode: 500 })).toBe(false);
		});
	});

	describe("model-provider fallback edge inputs", () => {
		it("fails over on the typed local-inference capability error", () => {
			expect(
				isModelProviderFallbackError({ code: "LOCAL_INFERENCE_UNAVAILABLE" }),
			).toBe(true);
			// The TTS gate runs before any classifier, so TTS never rotates.
			expect(
				isModelProviderFallbackError(
					{ code: "LOCAL_INFERENCE_UNAVAILABLE" },
					ModelType.TEXT_TO_SPEECH,
				),
			).toBe(false);
		});

		it("fails over on structural 529 and inherited rate limits", () => {
			expect(isModelProviderFallbackError({ statusCode: 529 })).toBe(true);
			expect(isModelProviderFallbackError({ statusCode: 429 })).toBe(true);
		});

		it("matches transient infrastructure substrings on real Errors only", () => {
			expect(isModelProviderFallbackError(new Error("socket hang up"))).toBe(
				true,
			);
			expect(isModelProviderFallbackError(new Error("request timed out"))).toBe(
				true,
			);
			// Non-Error values get no substring scan at all.
			expect(isModelProviderFallbackError("timed out")).toBe(false);
			expect(isModelProviderFallbackError({ statusCode: 400 })).toBe(false);
		});
	});

	describe("structured-failure cause classification edges", () => {
		it("surfaces repeated_failures provenance when the tool failure carried it", () => {
			const repeatedWithHandler = new TrajectoryLimitExceeded({
				kind: "repeated_failures",
				max: 3,
				observed: 3,
				failureProvenance: {
					kind: "handler_error",
					boundary: "handler",
					code: "ACTION_FAILED",
					retryable: true,
				},
			});
			expect(classifyStructuredFailureCause(repeatedWithHandler)).toBe(
				"handler_error",
			);
		});

		it("classifies provenance-less repeated failures and budget kinds as planner exhaustion", () => {
			expect(
				classifyStructuredFailureCause(
					new TrajectoryLimitExceeded({
						kind: "repeated_failures",
						max: 2,
						observed: 2,
					}),
				),
			).toBe("planner_exhaustion");
			expect(
				classifyStructuredFailureCause(
					new TrajectoryLimitExceeded({
						kind: "trajectory_token_budget",
						max: 1000,
						observed: 1001,
					}),
				),
			).toBe("planner_exhaustion");
			expect(
				classifyStructuredFailureCause(
					new TrajectoryLimitExceeded({
						kind: "terminal_only_continuations",
						max: 2,
						observed: 3,
					}),
				),
			).toBe("planner_exhaustion");
			expect(
				classifyStructuredFailureCause(
					new TrajectoryLimitExceeded({
						kind: "tool_calls",
						max: 10,
						observed: 11,
					}),
				),
			).toBe("planner_exhaustion");
		});

		it("reads action-failure provenance attached under an error context", () => {
			const persistenceLike = {
				context: {
					failureProvenance: {
						kind: "persistence_error",
						boundary: "persistence",
						code: "WRITE_FAILED",
						retryable: true,
					},
				},
			};
			expect(classifyStructuredFailureCause(persistenceLike)).toBe(
				"persistence_error",
			);
		});

		it("fails closed to transient on malformed thrown provenance", () => {
			expect(
				classifyStructuredFailureCause({
					failureProvenance: { kind: "nonsense" },
				}),
			).toBe("transient");
		});
	});

	describe("buildFailureReplyPrompt per-cause shaping", () => {
		it("defaults to the transient cause and its retry rule", () => {
			const prompt = buildFailureReplyPrompt("User: hi");
			expect(prompt).toContain("You hit a transient model error");
			expect(prompt).toContain(
				"- Acknowledge that something went wrong and suggest a retry.",
			);
		});

		it("shapes each distinguishable cause with its own line and retry rule", () => {
			const handlerPrompt = buildFailureReplyPrompt("c", "handler_error");
			expect(handlerPrompt).toContain(
				"An action failed while carrying out the user's request",
			);

			const persistencePrompt = buildFailureReplyPrompt(
				"c",
				"persistence_error",
			);
			expect(persistencePrompt).toContain(
				"The requested change reached its persistence boundary but could not be saved",
			);
			expect(persistencePrompt).toContain("suggest a retry.");

			const exhaustionPrompt = buildFailureReplyPrompt(
				"c",
				"planner_exhaustion",
			);
			expect(exhaustionPrompt).toContain(
				"You ran out of attempts while working on the user's request",
			);
		});

		it("orders the cause lines before the conversation and trailing Reply marker", () => {
			const prompt = buildFailureReplyPrompt(
				"User: hello",
				"missing_capability",
			);
			expect(prompt.trim().endsWith("Reply:")).toBe(true);
			expect(prompt.indexOf("capability which is not available")).toBeLessThan(
				prompt.indexOf("Recent Conversation:"),
			);
			expect(prompt.indexOf("Recent Conversation:")).toBeLessThan(
				prompt.indexOf("User: hello"),
			);
			expect(prompt).toContain("do not emit answer-shaped tokens");
		});
	});

	describe("stripReasoningBlocks residue shapes", () => {
		it("truncates an unclosed reasoning block to the pre-tag text", () => {
			expect(stripReasoningBlocks("Answer here <think>leaked chain")).toBe(
				"Answer here",
			);
		});

		it("discards leading close-only residue left by a repair pass", () => {
			expect(stripReasoningBlocks("None</think> Final answer")).toBe(
				"Final answer",
			);
		});

		it("strips every reasoning tag family case-insensitively", () => {
			expect(
				stripReasoningBlocks("<thinking>private</thinking>Visible reply"),
			).toBe("Visible reply");
			expect(stripReasoningBlocks("<THINK>x</think>Ok")).toBe("Ok");
		});

		it("collapses nested same-family tags to the nearest pairing then drops the residue", () => {
			expect(stripReasoningBlocks("<think>a<think>b</think>c</think>d")).toBe(
				"d",
			);
		});

		it("removes no_think markers including a leading slash but respects word boundaries", () => {
			expect(stripReasoningBlocks("/no_think Result")).toBe("Result");
			expect(stripReasoningBlocks("no_thinkReady stays")).toBe(
				"no_thinkReady stays",
			);
		});
	});
});
