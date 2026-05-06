import { describe, expect, it, vi } from "vitest";
import type { ActionResult, IAgentRuntime } from "../index";
import {
	actionResultsSuppressPostActionContinuation,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
	looksLikeSelfPolicyExplanationRequest,
	shouldPromoteExplicitReplyToOwnedAction,
	shouldSkipDocumentProviderRescue,
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
		expect(
			inferLocalShellCommandFromMessageText(
				"check git status in /home/alice/project and tell me the branch",
			),
		).toContain("git -C '/home/alice/project' status --short --branch");
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

	it("promotes explicit reply to direct shell/search action aliases", () => {
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "TERMINAL",
					score: 1,
					secondBestScore: 0,
					reasons: ["direct:local-shell-check"],
				},
			),
		).toBe(true);
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "BRAVE_SEARCH",
					score: 1,
					secondBestScore: 0,
					reasons: ["direct:web-search"],
				},
			),
		).toBe(true);
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "MANAGE_ISSUES",
					score: 1,
					secondBestScore: 0,
					reasons: ["metadata:keyword-overlap"],
				},
			),
		).toBe(false);
	});

	it("does not route generic current status questions to web search", () => {
		const runtime = {
			actions: [
				{
					name: "SEARCH",
					similes: ["WEB_SEARCH", "SEARCH_WEB"],
					description: "Search the web or other registered backends",
				},
			],
		} as unknown as Pick<IAgentRuntime, "actions">;

		expect(
			suggestOwnedActionFromMetadata(runtime, {
				content: {
					text: "what is the current status of the build?",
				},
			}),
		).toBeNull();
		expect(
			inferWebSearchQueryFromMessageText(
				"what is the current status of the build?",
			),
		).toBeNull();
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

	it("does not skip document rescue for ordinary second-person questions", () => {
		expect(
			shouldSkipDocumentProviderRescue({
				content: {
					text: "can you explain the uploaded document?",
				},
			} as unknown as Parameters<typeof shouldSkipDocumentProviderRescue>[0]),
		).toBe(false);
	});

	it("does not skip document rescue for self-policy questions about documents", () => {
		expect(
			shouldSkipDocumentProviderRescue({
				content: {
					text: "what workflow should you use for processing documents in your knowledge base?",
				},
			} as unknown as Parameters<typeof shouldSkipDocumentProviderRescue>[0]),
		).toBe(false);
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
