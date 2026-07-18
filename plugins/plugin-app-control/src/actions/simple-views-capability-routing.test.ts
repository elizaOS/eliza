/**
 * Cross-package contract coverage for the real developer Notes and Simple
 * Calendar declarations as consumed by the generic VIEWS interaction broker.
 * It guards against routing a Notes operation into Calendar or Documents when
 * foreground state or planner parameters disagree with the user's words.
 */

import type { ViewDeclaration } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleViewsPlugin } from "../../../plugin-simple-views/src/plugin.ts";
import { createViewsAction } from "./views.ts";
import type {
	CurrentViewSummary,
	ViewSummary,
	ViewsClient,
} from "./views-client.ts";

function summary(view: ViewDeclaration): ViewSummary {
	return {
		id: view.id,
		label: view.label,
		description: view.description,
		path: view.path,
		tags: view.tags,
		pluginName: simpleViewsPlugin.name,
		available: true,
		viewType: "gui",
		capabilities: view.capabilities,
		developerOnly: view.developerOnly,
		visibleInManager: view.visibleInManager,
	};
}

const SIMPLE_VIEWS = (simpleViewsPlugin.views ?? []).map(summary);
const DECOY_VIEWS: ViewSummary[] = [
	{
		id: "calendar",
		label: "Calendar",
		description: "Production calendar surface.",
		path: "/calendar",
		tags: ["calendar", "events"],
		pluginName: "@elizaos/plugin-calendar",
		available: true,
		viewType: "gui",
		capabilities: [
			{
				id: "create-event",
				description: "Create a production calendar event.",
				params: {
					title: { type: "string", description: "Event title." },
				},
			},
		],
	},
	{
		id: "documents",
		label: "Documents",
		description: "Production documents surface.",
		path: "/documents",
		tags: ["documents", "files"],
		pluginName: "@elizaos/plugin-documents",
		available: true,
		viewType: "gui",
		capabilities: [
			{
				id: "create-document",
				description: "Create a document.",
				params: {
					title: { type: "string", description: "Document title." },
				},
			},
		],
	},
];

function message(text: string) {
	return {
		entityId: "user-1",
		roomId: "room-1",
		agentId: "agent-1",
		content: { text },
	};
}

function currentView(viewId: string): CurrentViewSummary {
	const view = [...SIMPLE_VIEWS, ...DECOY_VIEWS].find(
		(candidate) => candidate.id === viewId,
	);
	if (!view) throw new Error(`Unknown test view ${viewId}.`);
	return {
		viewId,
		viewLabel: view.label,
		viewPath: view.path ?? null,
		viewType: "gui",
		updatedAt: "2026-07-17T12:00:00.000Z",
	};
}

describe("VIEWS routing for the real Simple Views manifest", () => {
	let foreground = "notes";
	let requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	let client: ViewsClient;

	beforeEach(() => {
		foreground = "notes";
		requests = [];
		client = {
			listViews: vi.fn(async () => [...SIMPLE_VIEWS, ...DECOY_VIEWS]),
			getCurrentView: vi.fn(async () => currentView(foreground)),
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const body =
					typeof init?.body === "string"
						? (JSON.parse(init.body) as Record<string, unknown>)
						: {};
				requests.push({ url: String(url), body });
				return {
					ok: true,
					status: 200,
					json: async () => ({
						success: true,
						result: { success: true, text: "Interaction completed." },
					}),
				} as Response;
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function run(text: string, options?: Record<string, unknown>) {
		return createViewsAction({
			client,
			hasOwnerAccess: vi.fn(async () => true),
		}).handler(
			{ agentId: "agent-1" } as never,
			message(text) as never,
			undefined,
			options,
			vi.fn(),
		);
	}

	it("targets Notes for create and list operations using its declared ids", async () => {
		const created = await run(
			"create a note titled Routing QA with body Keep Notes isolated",
			{
				action: "create",
				view: "notes",
				title: "Routing QA",
				body: "Keep Notes isolated",
			},
		);
		const listed = await run("list my notes", {
			action: "list",
			view: "notes",
		});

		expect(created?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(listed?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "get-notes",
		});
		expect(requests.map(({ url }) => url)).toEqual([
			expect.stringContaining("/api/views/notes/interact"),
			expect.stringContaining("/api/views/notes/interact"),
		]);
		expect(requests.map(({ body }) => body.capability)).toEqual([
			"create-note",
			"get-notes",
		]);
	});

	it.each([
		{
			text: "create a note titled Plugin Architecture",
			options: {
				action: "create",
				view: "notes",
				title: "Plugin Architecture",
			},
		},
		{
			text: "create a note about view switching",
			options: {
				action: "create",
				view: "notes",
				body: "view switching",
			},
		},
		{
			text: "create a note about view switching",
			options: undefined,
		},
		{
			text: "create a note in the Notes view titled Pane ownership",
			options: {
				action: "create",
				view: "notes",
				title: "Pane ownership",
			},
		},
	])("keeps view and plugin words inside Notes content", async ({
		text,
		options,
	}) => {
		const result = await run(text, options);

		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("/api/views/notes/interact");
	});

	it("keeps a destructive record command inside the named Notes view", async () => {
		const result = await run(
			"delete a note from the Notes view titled Plugin Architecture",
			{
				action: "delete",
				view: "notes",
				title: "Plugin Architecture",
			},
		);

		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "delete-note",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("/api/views/notes/interact");
	});

	it("reserves the destructive clear capability for an explicit bulk request", async () => {
		const result = await run("delete all notes", {
			action: "delete",
			view: "notes",
		});

		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "clear-notes",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("/api/views/notes/interact");
	});

	it("targets Simple Calendar for event creation without selecting production Calendar", async () => {
		const result = await run(
			"create an event titled View QA on 2026-07-18 at 14:30",
			{
				action: "create",
				view: "simple-calendar",
				title: "View QA",
				date: "2026-07-18",
				time: "14:30",
			},
		);

		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "simple-calendar",
			capability: "create-calendar-event",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("/api/views/simple-calendar/interact");
		expect(requests[0]?.url).not.toContain("/api/views/calendar/interact");
	});

	it.each([
		"calendar",
		"simple-calendar",
		"documents",
	])("keeps an unstructured Notes command on Notes while %s is foreground", async (foregroundView) => {
		foreground = foregroundView;
		const result = await run(
			"create a note titled Foreground isolation with body User words win",
			{ action: "create" },
		);

		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("/api/views/notes/interact");
		expect(requests[0]?.url).not.toContain(`/api/views/${foregroundView}/`);
	});

	it.each([
		"calendar",
		"simple-calendar",
		"documents",
	])("lets an explicit Notes request override a conflicting generic %s target", async (wrongView) => {
		const result = await run("create a note titled User request wins", {
			action: "create",
			view: wrongView,
			title: "User request wins",
		});

		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("/api/views/notes/interact");
		expect(requests[0]?.url).not.toContain(`/api/views/${wrongView}/`);
	});

	it("rejects a contradictory target when multiple event views are valid", async () => {
		const result = await run("create an event titled Ambiguous ownership", {
			action: "create",
			view: "notes",
			title: "Ambiguous ownership",
			date: "2026-07-18",
		});

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			reason: "capability-not-declared-by-explicit-view",
			viewId: "notes",
			operation: "create",
		});
		expect(requests).toHaveLength(0);
	});

	it.each([
		"calendar",
		"simple-calendar",
		"documents",
	])("rejects a conflicting %s planner target for an explicit Notes capability", async (wrongView) => {
		const result = await run("create a note titled Never cross domains", {
			action: "interact",
			view: wrongView,
			capability: "create-note",
			title: "Never cross domains",
		});

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			reason: "capability-not-declared-by-explicit-view",
			viewId: wrongView,
		});
		expect(requests).toHaveLength(0);
	});
});
