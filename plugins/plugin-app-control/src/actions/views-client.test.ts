/**
 * Views client tests for loopback API normalization and request construction.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createViewsClient,
	parseViewInteractionResponse,
	readViewInteractionReceipt,
} from "./views-client.js";

const coreMock = vi.hoisted(() => ({
	resolveServerOnlyPort: vi.fn(() => 3456),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return { ...actual, ...coreMock };
});

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	coreMock.resolveServerOnlyPort.mockClear();
});

describe("views client", () => {
	it("preserves complete static scoped-action declarations without copying renderer state", async () => {
		const scopedActions = [
			{
				name: "VIEW_CALENDAR_SELECT_VISIBLE_DAY",
				description: "Select a visible calendar day while Calendar is active.",
				parameters: ["date"],
				similes: ["SELECT_VISIBLE_DAY"],
				steps: [{ kind: "agent-click", target: "calendar-day-{{date}}" }],
			},
			{
				name: "VIEW_EDITOR_FILL",
				description: "Fill the focused editor without saving it.",
				parameters: ["content"],
				steps: [
					{ kind: "agent-focus", target: "editor" },
					{ kind: "agent-fill", target: "editor", value: "{{content}}" },
				],
			},
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					views: [
						{
							id: "calendar",
							label: "Calendar",
							pluginName: "@elizaos/plugin-calendar",
							available: true,
							scopedActions,
							elements: [{ id: "private-note", value: "other client text" }],
							selectedDate: "2026-09-06",
						},
					],
				}),
			),
		);

		const [view] = await createViewsClient().listViews();
		expect(view?.scopedActions).toEqual(scopedActions);
		expect(view).not.toHaveProperty("elements");
		expect(view).not.toHaveProperty("selectedDate");
	});

	it.each([
		{},
		{ name: "", description: "invalid", steps: [] },
		{ name: "INVALID", steps: [] },
		{ name: "INVALID", description: "invalid", steps: "click" },
		{
			name: "INVALID",
			description: "invalid",
			steps: [
				{ kind: "agent-click", target: "ok" },
				{ kind: "unknown", target: "bad" },
			],
		},
		{
			name: "INVALID",
			description: "invalid",
			steps: [{ kind: "agent-click" }],
		},
		{
			name: "INVALID",
			description: "invalid",
			steps: [{ kind: "agent-fill", target: "editor", value: 42 }],
		},
		{
			name: "INVALID",
			description: "invalid",
			steps: [],
			parameters: ["date", 42],
		},
		{ name: "INVALID", description: "invalid", steps: [], similes: "ALIAS" },
	])("drops an invalid scoped declaration as a whole: %j", async (invalid) => {
		const valid = {
			name: "VALID",
			description: "Valid action",
			steps: [{ kind: "agent-click", target: "ok" }],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					views: [
						{
							id: "calendar",
							label: "Calendar",
							pluginName: "@elizaos/plugin-calendar",
							available: true,
							scopedActions: [invalid, valid],
						},
					],
				}),
			),
		);

		const [view] = await createViewsClient().listViews();
		expect(view?.scopedActions).toEqual([valid]);
	});

	it.each([undefined, null, "invalid", {}])(
		"keeps absent or non-array scoped metadata compatible: %j",
		async (scopedActions) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({
						views: [
							{
								id: "legacy",
								label: "Legacy",
								pluginName: "@scenario/plugin-legacy",
								available: true,
								...(scopedActions === undefined ? {} : { scopedActions }),
							},
						],
					}),
				),
			);

			const [view] = await createViewsClient().listViews();
			expect(view?.id).toBe("legacy");
			expect(view).not.toHaveProperty("scopedActions");
		},
	);

	it("fails closed on malformed interaction response JSON", async () => {
		await expect(
			parseViewInteractionResponse({
				json: vi.fn(async () => {
					throw new SyntaxError("bad json");
				}),
			}),
		).resolves.toEqual({
			ok: false,
			error: "View interaction response was not valid JSON",
		});
	});

	it.each([
		[{ success: false, result: { success: true } }, false],
		[{ success: true, result: { success: false } }, false],
		[{ success: true, result: { success: true } }, true],
	])(
		"keeps wrapper and nested interaction success authoritative",
		async (body, success) => {
			await expect(
				parseViewInteractionResponse({ json: vi.fn(async () => body) }),
			).resolves.toMatchObject({ ok: true, success });
		},
	);

	it("rejects missing and non-boolean interaction success fields", async () => {
		await expect(
			parseViewInteractionResponse({
				json: vi.fn(async () => ({ result: { success: true } })),
			}),
		).resolves.toMatchObject({ ok: false });
		await expect(
			parseViewInteractionResponse({
				json: vi.fn(async () => ({
					success: true,
					result: { success: "yes" },
				})),
			}),
		).resolves.toMatchObject({ ok: false });
	});

	it("extracts only bounded mutation receipt fields", () => {
		expect(
			readViewInteractionReceipt({
				success: true,
				requestId: " request-7 ",
				result: {
					success: true,
					state: { revision: 12 },
					data: { note: { id: "note-12", body: "not in receipt" } },
				},
			}),
		).toEqual({
			requestId: "request-7",
			revision: 12,
			entity: { kind: "note", id: "note-12" },
		});
		expect(
			readViewInteractionReceipt({
				requestId: "x".repeat(257),
				result: {
					state: { revision: -1 },
					data: { event: { id: "" } },
				},
			}),
		).toBeUndefined();
	});

	it("normalizes legacy capability metadata from the view registry", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("http://127.0.0.1:3456/api/views");
			return jsonResponse({
				views: [
					{
						id: "remote-ledger",
						label: "Remote Ledger",
						pluginName: "@scenario/plugin-remote-ledger",
						available: true,
						capabilities: [
							{
								name: "fill-input",
								description: "Fill a named input in the view.",
								inputSchema: {
									type: "object",
									properties: {
										name: {
											type: "string",
											description: "Input name.",
										},
										value: { type: "string" },
									},
									required: ["name", "value"],
								},
							},
							{ description: "missing id/name should be ignored" },
						],
					},
				],
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(createViewsClient().listViews()).resolves.toMatchObject([
			{
				id: "remote-ledger",
				capabilities: [
					{
						id: "fill-input",
						description: "Fill a named input in the view.",
						params: {
							name: {
								type: "string",
								description: "Input name.",
								required: true,
							},
							value: {
								type: "string",
								description: "",
								required: true,
							},
						},
					},
				],
			},
		]);
	});

	it("preserves declared capability authority and drops undeclared values", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					views: [
						{
							id: "orchestrator",
							label: "Orchestrator",
							pluginName: "@elizaos/plugin-task-coordinator",
							available: true,
							capabilities: [
								{ id: "orchestrator-status", description: "Read status." },
								{
									id: "orchestrator-validate-task",
									description: "Approve task validation.",
									authority: "human",
								},
								{
									id: "orchestrator-create-task",
									description: "Create a task.",
									authority: "agent",
								},
								{
									id: "orchestrator-open-task",
									description: "Open a task.",
									authority: "root",
								},
							],
						},
					],
				}),
			),
		);

		const [view] = await createViewsClient().listViews();
		expect(view?.capabilities).toEqual([
			{ id: "orchestrator-status", description: "Read status." },
			{
				id: "orchestrator-validate-task",
				description: "Approve task validation.",
				authority: "human",
			},
			{
				id: "orchestrator-create-task",
				description: "Create a task.",
				authority: "agent",
			},
			{ id: "orchestrator-open-task", description: "Open a task." },
		]);
	});

	it("parses current-view state", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("http://127.0.0.1:3456/api/views/current");
			return jsonResponse({
				currentView: {
					viewId: "trajectory-logger",
					viewPath: "/trajectory-logger",
					viewLabel: "Trajectories",
					viewType: "gui",
					action: "open",
					updatedAt: "2026-05-31T08:00:00.000Z",
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(createViewsClient().getCurrentView()).resolves.toMatchObject({
			viewId: "trajectory-logger",
			viewPath: "/trajectory-logger",
			viewLabel: "Trajectories",
			viewType: "gui",
			action: "open",
			justSwitched: false,
			updatedAt: "2026-05-31T08:00:00.000Z",
		});
	});

	it("parses the open subview/section from current-view state (#9945)", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				currentView: {
					viewId: "settings",
					viewPath: "/settings",
					viewLabel: "Settings",
					viewType: "gui",
					subview: "voice",
					updatedAt: "2026-05-31T08:00:00.000Z",
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(createViewsClient().getCurrentView()).resolves.toMatchObject({
			viewId: "settings",
			subview: "voice",
		});
	});
});
