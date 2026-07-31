/**
 * Follow-up routing tests for view capability create, delete, and update intents.
 */

import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewFollowupRoutingEvaluator } from "./view-followup-routing.js";

// A notes-style view that supports both create and delete capabilities, used as
// the focused/active view in the loopback responses below.
const NOTES_VIEW = {
	id: "notes",
	label: "Notes",
	description: "Sticky notes board",
	pluginName: "@local/plugin-notes",
	available: true,
	tags: ["notes", "sticky-notes"],
	capabilities: [
		{
			id: "create-note",
			description: "Create a sticky note",
			params: {
				title: { type: "string", description: "Optional note title" },
				body: { type: "string", description: "Note body text" },
			},
		},
		{ id: "delete-note", description: "Delete a sticky note by id or title" },
	],
};

function message(text: string) {
	return { id: "m1", roomId: "room-1", content: { text } };
}

function context(
	text: string,
	overrides: Partial<ResponseHandlerEvaluatorContext> = {},
): ResponseHandlerEvaluatorContext {
	return {
		runtime: { agentId: "agent-1", actions: [{ name: "VIEWS" }] },
		message: message(text),
		state: {},
		messageHandler: {
			processMessage: "RESPOND",
			thought: "direct reply",
			plan: {
				contexts: ["simple"],
				requiresTool: false,
				reply: "Sure.",
			},
		},
		availableContexts: [{ id: "general" }, { id: "simple" }],
		...overrides,
	} as unknown as ResponseHandlerEvaluatorContext;
}

function mockLoopback(current: { viewId: string } | null) {
	vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
		const requestUrl = String(url);
		if (requestUrl.endsWith("/api/views/current")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					currentView: current
						? {
								viewId: current.viewId,
								viewPath: "/notes",
								viewLabel: "Notes",
								viewType: "gui",
								action: "open",
								updatedAt: "2026-06-08T00:00:00.000Z",
							}
						: null,
				}),
			} as Response;
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({ views: [NOTES_VIEW] }),
		} as Response;
	});
}

describe("viewFollowupRoutingEvaluator", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("routes a content-bearing un-named follow-up through VIEWS", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("can you make another one saying wake me at 3am");
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toMatchObject({
			requiresTool: true,
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: ["VIEWS"],
			deterministicToolCall: {
				name: "VIEWS",
				params: { action: "interact", view: "notes" },
			},
		});
	});

	it("routes a canonical referential content tail without using retrieved document verbs", async () => {
		mockLoopback({ viewId: "notes" });
		const wrapped = [
			"Answer the user request using the contextual documents below as the source of truth.",
			"<contextual_documents>",
			"Update that note and set its title.",
			"</contextual_documents>",
			"<user_request>",
			"create a new one to eat lunch",
			"</user_request>",
		].join("\n");
		const ctx = context(wrapped);

		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toMatchObject({
			debug: [
				"active view notes supports create; forcing sole deterministic VIEWS owner",
			],
		});
	});

	it("replaces a broad Stage-1 task route when the focused view owns the referent", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("create a new one to eat lunch");
		ctx.messageHandler.plan.requiresTool = true;
		ctx.messageHandler.plan.candidateActions = ["CREATE_TASK"];
		ctx.messageHandler.plan.parentActionHints = ["TASKS"];

		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toMatchObject({
			requiresTool: true,
			clearCandidateActions: true,
			addCandidateActions: ["VIEWS"],
			clearParentActionHints: true,
			addParentActionHints: ["VIEWS"],
			deterministicToolCall: {
				name: "VIEWS",
				params: { action: "interact", view: "notes" },
			},
		});
	});

	it("leaves an explicit standalone task request on its original route", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("create a task to eat lunch");
		ctx.messageHandler.plan.requiresTool = true;
		ctx.messageHandler.plan.candidateActions = ["CREATE_TASK"];

		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("routes a delete follow-up that references the active view", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("delete that one");
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toMatchObject({ addCandidateActions: ["VIEWS"] });
	});

	it("does NOT hijack 'set it up with them' (bare 'with' is not a content marker)", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("sure, set it up with them");
		// No strong content marker → the follow-up gate never fires, so the real
		// reply is preserved instead of being cleared with a canned "On it.".
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("leaves an ordinary non-view follow-up on the direct path", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("can you make another joke");
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("does not run when no VIEWS action is registered", async () => {
		const ctx = context("make another one saying hi", {
			runtime: { agentId: "agent-1", actions: [] },
		} as never);
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(false);
	});

	it("degrades to no-route when there is no focused view", async () => {
		mockLoopback(null);
		const ctx = context("make another one saying hi");
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toBeUndefined();
	});

	it("degrades to no-route when the loopback API is unreachable", async () => {
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
		const ctx = context("make another one saying hi");
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toBeUndefined();
	});
});
