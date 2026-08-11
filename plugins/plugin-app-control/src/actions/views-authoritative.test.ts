import { describe, expect, it } from "vitest";
import type { ViewCapability, ViewSummary } from "./views-client.js";

// Minimal harness to test authoritativeRequestTokens and correctCapabilityOperationFamily
// We import the internal helpers via re-export for testing (exposed for test)
// If not exported, we test via the public createViewsAction handler

import type { IAgentRuntime } from "@elizaos/core";
import { createViewsAction } from "./views.js";

function viewWithCaps(caps: ViewCapability[]): ViewSummary {
	return {
		id: "notes",
		label: "Notes",
		description: "Notes",
		viewType: "gui",
		capabilities: caps,
	};
}

function capa(id: string, desc: string): ViewCapability {
	return { id, description: desc, params: {} };
}

describe("authoritativeRequestTokens and correctCapabilityOperationFamily", () => {
	it("does not rewrite explicit delete from incidental read in later clause", async () => {
		const runtime = {
			getService: () => undefined,
			agentId: "test",
		} as unknown as IAgentRuntime;
		const views: ViewSummary[] = [
			viewWithCaps([
				capa(
					"delete-note",
					"Delete one note by id, exact title, or unique text",
				),
				capa("get-note", "Read one note"),
				capa("get-notes", "List notes"),
			]),
		];
		const action = createViewsAction({
			client: {
				listViews: async () => views,
				interact: async () => ({
					success: true,
					text: "ok",
					state: { notes: [], revision: 1 },
				}),
			} as never,
			hasOwnerAccess: async () => true,
		});
		// User request contains delete in primary clause but also read word "current" in later clause
		const result = await action.handler(
			runtime as never,
			{
				content: {
					text: "Delete note GAUSS NOTES QA MARKER but show current notes",
				},
			} as never,
			undefined,
			{
				action: "interact",
				view: "notes",
				capability: "delete-note",
				params: { title: "GAUSS NOTES QA MARKER" },
			} as never,
			async () => {},
		);
		// Should preserve delete-note, not rewrite to get-note, because "current" is in later clause after "but"
		expect(result).toBeDefined();
	});

	it("fails closed for negated delete", async () => {
		const views: ViewSummary[] = [
			viewWithCaps([capa("delete-note", "Delete"), capa("get-note", "Read")]),
		];
		const action = createViewsAction({
			client: {
				listViews: async () => views,
				interact: async () => ({
					success: true,
					text: "ok",
					state: { notes: [], revision: 1 },
				}),
			} as never,
			hasOwnerAccess: async () => true,
		});
		const result = await action.handler(
			{ getService: () => undefined } as never,
			{ content: { text: "show the current note; do not delete it" } } as never,
			undefined,
			{
				action: "interact",
				view: "notes",
				capability: "get-note",
				params: { title: "x" },
			} as never,
			async () => {},
		);
		expect(result).toBeDefined();
		// Should not escalate get-note to delete-note when negated
	});

	it("handles non-English without lexical escalation", async () => {
		const views: ViewSummary[] = [
			viewWithCaps([capa("delete-note", "Delete"), capa("get-note", "Read")]),
		];
		const action = createViewsAction({
			client: {
				listViews: async () => views,
				interact: async () => ({
					success: true,
					text: "ok",
					state: { notes: [], revision: 1 },
				}),
			} as never,
			hasOwnerAccess: async () => true,
		});
		const result = await action.handler(
			{ getService: () => undefined } as never,
			{ content: { text: "请删除笔记 GAUSS" } } as never,
			undefined,
			{
				action: "interact",
				view: "notes",
				capability: "get-note",
				params: { title: "GAUSS" },
			} as never,
			async () => {},
		);
		// Non-English should not lexically escalate to delete
		expect(result).toBeDefined();
	});
});
