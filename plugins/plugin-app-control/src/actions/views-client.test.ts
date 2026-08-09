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

vi.mock("@elizaos/core", () => coreMock);

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
		[{ success: true, result: { ok: false } }, false],
		[{ success: true, result: { ok: true } }, true],
		[{ success: true, result: { success: true, ok: false } }, false],
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
