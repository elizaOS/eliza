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

const CALENDAR_VIEW = {
	id: "simple-calendar",
	label: "Simple Calendar",
	description: "Calendar workbench",
	pluginName: "@local/plugin-simple-calendar",
	available: true,
	tags: ["calendar", "events"],
	capabilities: [
		{
			id: "create-calendar-event",
			description: "Create a calendar event",
		},
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
		const patch = await viewFollowupRoutingEvaluator.evaluate(ctx);
		expect(patch).toMatchObject({
			requiresTool: true,
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: ["VIEWS"],
			clearParentActionHints: true,
			addParentActionHints: ["VIEWS"],
			deterministicToolCall: {
				name: "VIEWS",
				params: { action: "interact", view: "notes" },
			},
		});
		expect(patch?.reply).toBeUndefined();
	});

	it("routes a delete follow-up that references the active view", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("delete that one");
		expect(await viewFollowupRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toMatchObject({
			clearCandidateActions: true,
			addCandidateActions: ["VIEWS"],
			deterministicToolCall: {
				name: "VIEWS",
				params: { action: "interact", view: "notes" },
			},
		});
	});

	it("replaces competing candidates so VIEWS is the sole owner", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("make another one saying ship it", {
			messageHandler: {
				processMessage: "RESPOND",
				thought: "ambiguous planner guess",
				plan: {
					contexts: ["simple"],
					requiresTool: false,
					reply: "Maybe I should use another action.",
					candidateActions: ["DOCUMENTS", "REPLY"],
					parentActionHints: ["DOCUMENTS"],
				},
			},
		});

		await expect(
			viewFollowupRoutingEvaluator.evaluate(ctx),
		).resolves.toMatchObject({
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: ["VIEWS"],
			clearParentActionHints: true,
			addParentActionHints: ["VIEWS"],
			deterministicToolCall: { name: "VIEWS" },
		});
	});

	it("routes same-room follow-ups through each originating client's active view", async () => {
		vi.mocked(globalThis.fetch).mockImplementation(
			async (url, init?: RequestInit) => {
				const requestUrl = String(url);
				const clientId = new Headers(init?.headers).get("X-ElizaOS-Client-Id");
				if (requestUrl.endsWith("/api/views/current")) {
					const current = clientId === "shell-a" ? NOTES_VIEW : CALENDAR_VIEW;
					return {
						ok: true,
						status: 200,
						json: async () => ({
							currentView: {
								viewId: current.id,
								viewPath: `/${current.id}`,
								viewLabel: current.label,
								viewType: "gui",
								updatedAt: "2026-07-17T12:00:00.000Z",
							},
						}),
					} as Response;
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ views: [NOTES_VIEW, CALENDAR_VIEW] }),
				} as Response;
			},
		);
		const shellA = {
			...message("make another one saying buy milk"),
			id: "m-shell-a",
			metadata: { type: "message", clientId: "shell-a" },
		};
		const shellB = {
			...message("make another one saying planning review"),
			id: "m-shell-b",
			metadata: { type: "message", clientId: "shell-b" },
		};

		const [patchA, patchB] = await Promise.all([
			viewFollowupRoutingEvaluator.evaluate(
				context("make another one saying buy milk", {
					message: shellA,
				} as never),
			),
			viewFollowupRoutingEvaluator.evaluate(
				context("make another one saying planning review", {
					message: shellB,
				} as never),
			),
		]);

		expect(shellA.roomId).toBe(shellB.roomId);
		expect(patchA?.deterministicToolCall).toMatchObject({
			name: "VIEWS",
			params: { action: "interact", view: "notes" },
		});
		expect(patchB?.deterministicToolCall).toMatchObject({
			name: "VIEWS",
			params: { action: "interact", view: "simple-calendar" },
		});
		const clientIds = vi
			.mocked(globalThis.fetch)
			.mock.calls.map(([, init]) =>
				new Headers(init?.headers).get("X-ElizaOS-Client-Id"),
			);
		expect(clientIds.filter((id) => id === "shell-a")).toHaveLength(2);
		expect(clientIds.filter((id) => id === "shell-b")).toHaveLength(2);
	});

	it("does NOT hijack 'set it up with them' (bare 'with' is not a content marker)", async () => {
		mockLoopback({ viewId: "notes" });
		const ctx = context("sure, set it up with them");
		// No strong content marker → the follow-up gate never fires, so the real
		// reply is preserved instead of being claimed by the VIEWS action.
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
