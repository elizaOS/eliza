import { describe, expect, it, vi } from "vitest";
import { parseActionParams } from "../actions";
import type { ActionResult, IAgentRuntime } from "../index";
import {
	actionResultsSuppressPostActionContinuation,
	extractPlannerActionNames,
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
	it("extracts inline params from planner action strings", () => {
		const shellPlan: Record<string, unknown> = {
			actions: 'SHELL_COMMAND <params>{"command":"df -h"}</params>',
			params: {},
		};
		expect(extractPlannerActionNames(shellPlan)).toEqual(["SHELL_COMMAND"]);
		expect(parseActionParams(shellPlan.params).get("SHELL_COMMAND")).toEqual({
			command: "df -h",
		});

		const appPlan: Record<string, unknown> = {
			actions:
				'APP {"mode":"create","app":"normie-slider","intent":"build, verify, and report"}',
			params: {},
		};
		expect(extractPlannerActionNames(appPlan)).toEqual(["APP"]);
		expect(parseActionParams(appPlan.params).get("APP")).toEqual({
			mode: "create",
			app: "normie-slider",
			intent: "build, verify, and report",
		});
	});

	it("does not treat params tags inside inline JSON strings as XML wrappers", () => {
		const plan: Record<string, unknown> = {
			actions:
				'APP {"note":"literal <params, marker","intent":"build, verify"}, SHELL_COMMAND <params>{"command":"df -h"}</params>',
			params: {},
		};

		expect(extractPlannerActionNames(plan)).toEqual(["APP", "SHELL_COMMAND"]);
		const params = parseActionParams(plan.params);
		expect(params.get("APP")).toEqual({
			note: "literal <params, marker",
			intent: "build, verify",
		});
		expect(params.get("SHELL_COMMAND")).toEqual({ command: "df -h" });
	});

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
		expect(
			inferLocalShellCommandFromMessageText(
				"explain how df -h checks disk space on this VPS",
			),
		).toBeNull();
		expect(
			inferLocalShellCommandFromMessageText(
				"explain how to run df -h on this VPS",
			),
		).toBeNull();
		expect(inferLocalShellCommandFromMessageText("run df -h on this VPS")).toBe(
			"df -h",
		);
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

	it("does not promote explanation-only shell questions into execution", () => {
		const runtime = {
			actions: [
				{
					name: "SHELL_COMMAND",
					description: "Run local shell commands",
				},
			],
		} as unknown as Pick<IAgentRuntime, "actions">;
		const text = "explain how df -h checks disk space on this VPS";
		const howToRunText = "explain how to run df -h on this VPS";

		expect(
			suggestOwnedActionFromMetadata(runtime, {
				content: { text },
			}),
		).toBeNull();
		expect(
			suggestOwnedActionFromMetadata(runtime, {
				content: { text: howToRunText },
			}),
		).toBeNull();
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "SHELL_COMMAND",
					score: 100,
					secondBestScore: 0,
					reasons: ["direct:local-shell-check"],
				},
				text,
			),
		).toBe(false);
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "SHELL_COMMAND",
					score: 100,
					secondBestScore: 0,
					reasons: ["direct:local-shell-check"],
				},
				howToRunText,
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
