/**
 * Views client tests for loopback API normalization and request construction.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createViewsClient,
	getCurrentViewSnapshot,
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

	it("parses XR current-view state", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("http://127.0.0.1:3456/api/views/current");
			return jsonResponse({
				revision: 4,
				currentView: {
					viewId: "smartglasses",
					viewPath: "/apps/smartglasses",
					viewLabel: "Smartglasses",
					viewType: "xr",
					action: "open",
					panes: [
						{ viewId: "smartglasses", viewType: "xr" },
						{ viewId: "notes", viewType: "gui" },
					],
					updatedAt: "2026-05-31T08:00:00.000Z",
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(createViewsClient().getCurrentView()).resolves.toMatchObject({
			viewId: "smartglasses",
			viewPath: "/apps/smartglasses",
			viewLabel: "Smartglasses",
			viewType: "xr",
			action: "open",
			panes: [
				{ viewId: "smartglasses", viewType: "xr" },
				{ viewId: "notes", viewType: "gui" },
			],
			justSwitched: false,
			updatedAt: "2026-05-31T08:00:00.000Z",
		});
	});

	it("rejects the entire current layout when a middle pane is malformed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					revision: 4,
					currentView: {
						viewId: "smartglasses",
						viewPath: "/apps/smartglasses",
						viewLabel: "Smartglasses",
						viewType: "xr",
						panes: [
							{ viewId: "smartglasses", viewType: "xr" },
							{ viewId: "", viewType: "gui" },
							{ viewId: "notes", viewType: "gui" },
						],
						updatedAt: "2026-05-31T08:00:00.000Z",
					},
				}),
			),
		);

		await expect(createViewsClient().getCurrentView()).rejects.toThrow(
			"Malformed currentView.panes",
		);
	});

	it("parses the open subview/section from current-view state (#9945)", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				revision: 7,
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

	it("scopes reads and conditional navigation to one renderer client", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					revision: 3,
					currentView: {
						viewId: "settings",
						viewPath: "/settings",
						viewLabel: "Settings",
						viewType: "gui",
						updatedAt: "2026-05-31T08:00:00.000Z",
					},
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					ok: true,
					accepted: true,
					delivery: "delivered",
					revision: 4,
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = createViewsClient({ clientId: "renderer-a" });

		await expect(client.getCurrentView()).resolves.toMatchObject({
			viewId: "settings",
		});
		await expect(
			client.navigate("character", {
				expectedRevision: 3,
				subview: "profile",
			}),
		).resolves.toEqual({
			accepted: true,
			delivery: "delivered",
			revision: 4,
		});

		const currentInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(currentInit.headers).toMatchObject({
			"X-ElizaOS-Client-Id": "renderer-a",
		});
		const navigateInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
		expect(navigateInit.headers).toMatchObject({
			"X-ElizaOS-Client-Id": "renderer-a",
		});
		expect(JSON.parse(String(navigateInit.body))).toMatchObject({
			expectedRevision: 3,
			subview: "profile",
			clientId: "renderer-a",
		});
	});

	it("mints a stable per-turn operation id and requires the exact receipt", async () => {
		const operationIds: string[] = [];
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "GET") {
					return jsonResponse({ revision: 0, currentView: null });
				}
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				const operationId = String(body.operationId);
				operationIds.push(operationId);
				return jsonResponse({
					ok: true,
					accepted: true,
					delivery: "pending",
					deliveryOwner: "outbox",
					operationId,
					operationRevision: operationIds.length,
					revision: operationIds.length,
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const first = createViewsClient({
			clientId: "renderer-a",
			navigationOperationScope: "message-1",
		});
		const retried = createViewsClient({
			clientId: "renderer-a",
			navigationOperationScope: "message-1",
		});
		await first.navigate("notes", { path: "/notes", viewType: "gui" });
		await retried.navigate("notes", { path: "/notes", viewType: "gui" });
		await retried.navigate("notes", {
			path: "/notes",
			viewType: "gui",
			action: "open-window",
		});

		expect(operationIds[0]).toMatch(/^views:[a-f0-9]{64}$/);
		expect(operationIds[1]).toBe(operationIds[0]);
		expect(operationIds[2]).not.toBe(operationIds[0]);
		for (const call of fetchMock.mock.calls) {
			const init = call[1];
			if (init?.method !== "POST") continue;
			expect(JSON.parse(String(init.body))).toMatchObject({
				deliveryOwner: "outbox",
				clientId: "renderer-a",
			});
		}
	});

	it("rejects an outbox response that does not echo the caller operation id", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ revision: 0, currentView: null }))
				.mockResolvedValueOnce(
					jsonResponse({
						ok: true,
						accepted: true,
						delivery: "pending",
						deliveryOwner: "outbox",
						operationId: "views:another-operation",
						operationRevision: 1,
						revision: 1,
					}),
				),
		);

		await expect(
			createViewsClient({
				clientId: "renderer-a",
				navigationOperationScope: "message-1",
			}).navigate("notes"),
		).rejects.toThrow("missing operation receipt");
	});

	it("rejects unsupported and malformed navigation instead of fabricating success", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ revision: 0, currentView: null }))
				.mockResolvedValueOnce(new Response("not found", { status: 404 })),
		);
		await expect(createViewsClient().navigate("missing")).rejects.toThrow(
			"HTTP 404",
		);

		vi.mocked(fetch)
			.mockReset()
			.mockResolvedValueOnce(jsonResponse({ revision: 0, currentView: null }))
			.mockResolvedValueOnce(jsonResponse({ ok: true, revision: 1 }));
		await expect(createViewsClient().navigate("notes")).rejects.toThrow(
			"not accepted",
		);
	});

	it("fails closed when the current-view snapshot omits its revision", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ currentView: null })),
		);

		await expect(getCurrentViewSnapshot("renderer-a")).rejects.toThrow(
			"missing revision",
		);
	});
});
