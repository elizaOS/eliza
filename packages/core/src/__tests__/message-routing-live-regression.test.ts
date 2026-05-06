import { describe, expect, it, vi } from "vitest";
import type { ActionResult, IAgentRuntime } from "../index";
import {
	actionResultsSuppressPostActionContinuation,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
	looksLikeSelfPolicyExplanationRequest,
	stripReplyWhenActionOwnsTurn,
	suggestOwnedActionFromMetadata,
} from "../services/message";

const logger = {
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("live routing regressions", () => {
	it("collapses duplicate visible REPLY planner actions", () => {
		expect(
			stripReplyWhenActionOwnsTurn(
				{ actions: [], logger } as unknown as Pick<
					IAgentRuntime,
					"actions" | "logger"
				>,
				["REPLY", "REPLY"],
			),
		).toEqual(["REPLY"]);
	});

	it("dedupes aliases against registered canonical action names", () => {
		expect(
			stripReplyWhenActionOwnsTurn(
				{
					actions: [{ name: "REPLY", similes: ["RESPOND"] }],
					logger,
				} as unknown as Pick<IAgentRuntime, "actions" | "logger">,
				["RESPOND", "REPLY"],
			),
		).toEqual(["RESPOND"]);
	});

	it("infers safe params for explicit local shell checks", () => {
		expect(
			inferLocalShellCommandFromMessageText(
				"check disk space on this VPS with df -h",
			),
		).toBe("df -h");
		expect(
			inferLocalShellCommandFromMessageText(
				"which folder is live read-only? answer paths only. do not run commands.",
			),
		).toBeNull();
	});

	it("recognizes current-info requests as web search without spawning work", () => {
		const runtime = {
			actions: [
				{
					name: "SEARCH",
					similes: ["WEB_SEARCH", "SEARCH_WEB"],
					description: "Search the web or other registered backends",
				},
			],
		} as unknown as Pick<IAgentRuntime, "actions">;

		const suggestion = suggestOwnedActionFromMetadata(runtime, {
			content: {
				text: "what is the current BTC price in USD? answer briefly.",
			},
		});

		expect(suggestion).toMatchObject({
			actionName: "SEARCH",
			reasons: ["direct:web-search"],
		});
		expect(
			inferWebSearchQueryFromMessageText(
				"what is the current BTC price in USD? answer briefly.",
			),
		).toBe("current BTC price in USD");
	});

	it("does not rescue self-policy explanation questions into task actions", () => {
		expect(
			looksLikeSelfPolicyExplanationRequest({
				content: {
					text: "for a new monetized ai chat app, what workflow, example app, and sdk should you use? answer in one short sentence. do not build anything.",
				},
			}),
		).toBe(true);
	});

	it("stops continuation when an action result blocks the turn", () => {
		expect(
			actionResultsSuppressPostActionContinuation([
				{
					success: false,
					text: "Permission denied",
					data: {
						actionName: "SHELL_COMMAND",
						terminal: { permissionDenied: true },
					},
				} as ActionResult,
			]),
		).toBe(true);
		expect(
			actionResultsSuppressPostActionContinuation([
				{ success: true, text: "done", data: { actionName: "SEARCH" } },
			] as ActionResult[]),
		).toBe(false);
	});
});
