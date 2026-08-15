/**
 * Pins `buildFailureReplyPrompt` and the `isRateLimitError` /
 * `isModelProviderFallbackError` classifiers (services/message) against the live
 * hallucination and 429-cascade regressions detailed below. Pure-function checks,
 * no runtime.
 */
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { TrajectoryLimitExceeded } from "../../runtime/limits";
import { ModelType } from "../../types";
import {
	buildFailureReplyPrompt,
	classifyStructuredFailureCause,
	isModelProviderFallbackError,
	isRateLimitError,
} from "../message";

/**
 * Pinned hard rules for the transient-failure reply prompt.
 *
 * BACKGROUND — live regression on Cerebras gpt-oss-120b (2026-05-12):
 * a user asked "what is the SHA of the latest commit on develop in
 * /home/eliza/iqlabs/eliza/eliza ? short sha only". The planner
 * trajectory errored (no stages recorded, finalDecision=error) and the
 * fallback failure-reply path emitted a SHA that appeared in recent
 * conversation context but did not match the actual current SHA.
 *
 * Root cause: the failure prompt contained the line
 *
 *   "If the user already gave a clear command and you can plausibly act,
 *    acknowledge it and offer to take the action directly."
 *
 * which the model read as license to invent an answer from context.
 *
 * Fix: the prompt now explicitly forbids answering the question on the
 * merits during a failure reply — even when the answer looks obvious —
 * because the grounding trajectory never ran. These tests pin the
 * forbid-list so a later "let's make the failure reply more helpful"
 * refactor can't silently re-introduce the hallucination vector.
 */
describe("buildFailureReplyPrompt", () => {
	const RECENT =
		"@e2e: what is the SHA of the latest commit on develop?\n@bot: 7593";

	it("includes the explicit NEVER-answer-on-the-merits rule", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain("NEVER answer the user's question on the merits");
		expect(prompt).toContain(
			"The trajectory that would have GROUNDED the answer failed",
		);
	});

	it("enumerates the answer-shaped tokens it must refuse to emit", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		// Must list SHA, count, price, date, status, file path, name —
		// these are the specific identifier-shaped categories the model
		// was previously tempted to fabricate from context.
		expect(prompt).toContain("a SHA");
		expect(prompt).toContain("a count");
		expect(prompt).toContain("a price");
		expect(prompt).toContain("a date");
		expect(prompt).toContain("a status");
		expect(prompt).toContain("a file path");
		expect(prompt).toContain("a name");
	});

	it("does NOT contain the removed 'plausibly act' escape hatch", () => {
		// Regression guard against the exact wording that caused the
		// hallucination. If anyone re-introduces this phrasing the bot
		// can re-hallucinate.
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).not.toContain("plausibly act");
		expect(prompt).not.toContain("take the action directly");
	});

	it("requires the reply to invite a retry", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain("Acknowledge that something went wrong");
		expect(prompt).toContain("suggest a retry");
	});

	it("forbids paraphrasing the user's question as if about to answer", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain("Do not paraphrase or echo the user's question");
	});

	it("embeds the recent conversation verbatim for the model to keep voice", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain(RECENT);
		// The recent-conversation block lives below the rules so the
		// rules anchor before the context.
		const ruleIdx = prompt.indexOf("Hard rules:");
		const recentIdx = prompt.indexOf("Recent Conversation:");
		expect(ruleIdx).toBeGreaterThanOrEqual(0);
		expect(recentIdx).toBeGreaterThan(ruleIdx);
	});

	it("preserves the internal-mechanism vocabulary blocklist", () => {
		// The bot's character protects against tech-jargon leaks via this
		// list. Keep it pinned so blanket rewrites of the prompt don't
		// accidentally drop it.
		const prompt = buildFailureReplyPrompt(RECENT);
		for (const term of [
			"planner",
			"action_planner",
			"XML",
			"JSON",
			"schema",
			"prompt",
			"runtime",
		]) {
			expect(prompt).toContain(term);
		}
	});

	it("preserves the punctuation rule (no em-dash / en-dash)", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain(
			"Do not use em-dashes or en-dashes. Use a plain hyphen, period, or comma.",
		);
	});

	it("does not leak any obvious internal trace into the prompt itself", () => {
		// Catch accidental newlines / markdown formatting that would
		// confuse the model. The prompt should be a clean plain-text
		// instruction block ending with the literal "Reply:" anchor.
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt.endsWith("Reply:")).toBe(true);
		expect(prompt).not.toContain("```");
	});
});

/**
 * #17027 AC6 — distinguishable failure causes. A missing capability, planner
 * exhaustion, and a transient provider blip must produce distinguishable
 * user-facing replies; the cause is classified structurally from the error
 * that killed the runtime, never from prose.
 */
describe("classifyStructuredFailureCause", () => {
	it("maps required_tool_misses to missing_capability", () => {
		const error = new TrajectoryLimitExceeded({
			kind: "required_tool_misses",
			max: 3,
			observed: 4,
		});
		expect(classifyStructuredFailureCause(error)).toBe("missing_capability");
	});

	it("maps unavailable_tool_calls to missing_capability", () => {
		const error = new TrajectoryLimitExceeded({
			kind: "unavailable_tool_calls",
			max: 3,
			observed: 4,
		});
		expect(classifyStructuredFailureCause(error)).toBe("missing_capability");
	});

	it("maps every non-causal trajectory limit to planner_exhaustion", () => {
		for (const kind of [
			"tool_calls",
			"terminal_only_continuations",
			"trajectory_token_budget",
		] as const) {
			const error = new TrajectoryLimitExceeded({
				kind,
				max: 16,
				observed: 17,
			});
			expect(classifyStructuredFailureCause(error)).toBe("planner_exhaustion");
		}
	});

	it("uses repeated action-failure provenance instead of collapsing it", () => {
		const handler = new TrajectoryLimitExceeded({
			kind: "repeated_failures",
			max: 2,
			observed: 3,
			failureProvenance: {
				kind: "handler_error",
				boundary: "handler",
				code: "HANDLER_FAILED",
				retryable: true,
			},
		});
		const persistence = new TrajectoryLimitExceeded({
			kind: "repeated_failures",
			max: 2,
			observed: 3,
			failureProvenance: {
				kind: "persistence_error",
				boundary: "persistence",
				code: "WRITE_FAILED",
				retryable: true,
			},
		});
		expect(classifyStructuredFailureCause(handler)).toBe("handler_error");
		expect(classifyStructuredFailureCause(persistence)).toBe(
			"persistence_error",
		);
		expect(
			classifyStructuredFailureCause(
				new TrajectoryLimitExceeded({
					kind: "repeated_failures",
					max: 2,
					observed: 3,
				}),
			),
		).toBe("planner_exhaustion");
	});

	it("maps arbitrary errors and non-errors to transient", () => {
		expect(classifyStructuredFailureCause(new Error("ECONNRESET"))).toBe(
			"transient",
		);
		expect(classifyStructuredFailureCause("boom")).toBe("transient");
		expect(classifyStructuredFailureCause(undefined)).toBe("transient");
	});
});

describe("buildFailureReplyPrompt per-cause variants", () => {
	const RECENT = "@user: track my daily pushups";

	it("missing_capability names the gap and forbids a retry promise", () => {
		const prompt = buildFailureReplyPrompt(RECENT, "missing_capability");
		expect(prompt).toContain("capability which is not available");
		expect(prompt).toContain("not able to do that here right now");
		expect(prompt).toContain("Do NOT claim it was done");
		expect(prompt).not.toContain("suggest a retry");
	});

	it("planner_exhaustion admits the request was not finished", () => {
		const prompt = buildFailureReplyPrompt(RECENT, "planner_exhaustion");
		expect(prompt).toContain("ran out of attempts");
		expect(prompt).toContain("could not finish the request");
		expect(prompt).toContain("suggest a retry");
	});

	it("handler and persistence variants name different failed boundaries", () => {
		const handler = buildFailureReplyPrompt(RECENT, "handler_error");
		const persistence = buildFailureReplyPrompt(RECENT, "persistence_error");
		expect(handler).toContain("An action failed");
		expect(handler).toContain("was not completed");
		expect(persistence).toContain("could not be saved");
		expect(persistence).toContain("must not be described as completed");
	});

	it("explicit transient matches the default prompt byte-for-byte", () => {
		expect(buildFailureReplyPrompt(RECENT, "transient")).toBe(
			buildFailureReplyPrompt(RECENT),
		);
	});

	it("every variant keeps the never-answer-on-the-merits rule", () => {
		for (const cause of [
			"missing_capability",
			"handler_error",
			"persistence_error",
			"planner_exhaustion",
			"transient",
		] as const) {
			const prompt = buildFailureReplyPrompt(RECENT, cause);
			expect(prompt).toContain(
				"NEVER answer the user's question on the merits",
			);
			expect(prompt.endsWith("Reply:")).toBe(true);
		}
	});
});

/**
 * BACKGROUND — live regression on Cerebras gpt-oss-120b (2026-05-27):
 * "Write me a haiku about the Israel Iran war" + "What
 * was the actual error?" both errored with 0 trajectory stages. bot.log:
 * `AI_RetryError: Failed after 3 attempts. Last error: Too Many Requests`
 * cascaded across all four model slots (TEXT_LARGE -> RESPONSE_HANDLER ->
 * TEXT_SMALL -> TEXT_NANO), all 429. The failure path then emitted the
 * opaque "Something went wrong on my end." The user could not tell the
 * outage was provider throttling vs. a real bug.
 *
 * Fix: detect rate-limit / 429 failures so the failure reply can say
 * "I'm being rate-limited, try again shortly" instead. These tests pin
 * the detector so the classification can't silently regress.
 */
describe("isRateLimitError", () => {
	it("matches the AI SDK retry-exhausted 429 shape from the live incident", () => {
		const err = new Error(
			"Failed after 3 attempts. Last error: Too Many Requests",
		);
		err.name = "AI_RetryError";
		expect(isRateLimitError(err)).toBe(true);
	});

	// REAL-SHAPE regression: the AI SDK carries the upstream HTTP status on
	// `APICallError.statusCode` (NOT `.status`), wrapped by `RetryError` when
	// retries are exhausted. With NO rate-limit substring in the message, the
	// structural status path is the ONLY signal — this case fails against a
	// brittle `.status === 429` / message-regex-only detector.
	it("detects a bare APICallError(statusCode: 429) structurally (no message hint)", () => {
		const err = new APICallError({
			message: "upstream error",
			url: "https://api.cerebras.ai/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 429,
		});
		expect(err.message.toLowerCase()).not.toContain("rate");
		expect(err.message).not.toContain("429");
		expect(isRateLimitError(err)).toBe(true);
	});

	it("unwraps a RetryError-wrapped APICallError(statusCode: 429) structurally", () => {
		const inner = new APICallError({
			message: "upstream error",
			url: "https://api.cerebras.ai/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 429,
		});
		const err = new RetryError({
			message: "Failed after 3 attempts.",
			reason: "maxRetriesExceeded",
			errors: [inner],
		});
		expect(err.message).not.toContain("Too Many Requests");
		expect(isRateLimitError(err)).toBe(true);
	});

	it("does not treat a non-429 APICallError as a rate limit", () => {
		const err = new APICallError({
			message: "upstream error",
			url: "https://api.cerebras.ai/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 500,
		});
		expect(isRateLimitError(err)).toBe(false);
	});

	it("matches common rate-limit phrasings case-insensitively", () => {
		for (const msg of [
			"429 Too Many Requests",
			"Rate limit exceeded",
			"rate_limit_error",
			"RateLimitError: slow down",
		]) {
			expect(isRateLimitError(new Error(msg))).toBe(true);
		}
	});

	it("does not match unrelated runtime errors", () => {
		for (const msg of [
			"NoModelProviderConfiguredError",
			"ECONNREFUSED 127.0.0.1:443",
			"invalid JSON in tool args",
			"context length exceeded",
		]) {
			expect(isRateLimitError(new Error(msg))).toBe(false);
		}
	});

	it("returns false for non-Error inputs", () => {
		expect(isRateLimitError("Too Many Requests")).toBe(false);
		expect(isRateLimitError(null)).toBe(false);
		expect(isRateLimitError(undefined)).toBe(false);
		expect(isRateLimitError({ message: "429" })).toBe(false);
	});
});

describe("isModelProviderFallbackError", () => {
	it("treats typed local-inference unavailability as a provider failover signal", () => {
		const error = Object.assign(new Error("native binding unavailable"), {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
		});

		expect(
			isModelProviderFallbackError(error, ModelType.RESPONSE_HANDLER),
		).toBe(true);
		expect(isModelProviderFallbackError(error, ModelType.TEXT_TO_SPEECH)).toBe(
			false,
		);
	});

	it("reuses the rate-limit classifier for CLI-SDK subscription/session limits", () => {
		expect(
			isModelProviderFallbackError(
				new Error("You've hit your session limit. Please try again later."),
			),
		).toBe(true);
	});

	it("unwraps a RetryError-wrapped 5xx APICallError structurally", () => {
		const inner = new APICallError({
			message: "upstream unavailable",
			url: "https://api.example.test/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 503,
		});
		const err = new RetryError({
			message: "Failed after 3 attempts.",
			reason: "maxRetriesExceeded",
			errors: [inner],
		});
		expect(isModelProviderFallbackError(err)).toBe(true);
	});

	it("does not treat non-retryable auth or validation errors as provider fallback", () => {
		for (const statusCode of [400, 401, 403, 404]) {
			const err = new APICallError({
				message: "non retryable upstream error",
				url: "https://api.example.test/v1/chat/completions",
				requestBodyValues: {},
				statusCode,
			});
			expect(isModelProviderFallbackError(err)).toBe(false);
		}
	});
});
