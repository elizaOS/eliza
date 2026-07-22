/**
 * Views client tests for loopback API normalization and request construction.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewsClient, getCurrentViewSnapshot } from "./views-client.js";

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
				currentView: {
					viewId: "smartglasses",
					viewPath: "/apps/smartglasses",
					viewLabel: "Smartglasses",
					viewType: "xr",
					action: "open",
					updatedAt: "2026-05-31T08:00:00.000Z",
				},
				revision: 3,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(createViewsClient().getCurrentView()).resolves.toMatchObject({
			viewId: "smartglasses",
			viewPath: "/apps/smartglasses",
			viewLabel: "Smartglasses",
			viewType: "xr",
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
				revision: 4,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(createViewsClient().getCurrentView()).resolves.toMatchObject({
			viewId: "settings",
			subview: "voice",
		});
	});

	it("preserves the server revision for compare-and-set navigation", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					currentView: null,
					revision: 17,
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ ok: true, revision: 18 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getCurrentViewSnapshot("shell-a")).resolves.toEqual({
			currentView: null,
			revision: 17,
		});
		await expect(
			createViewsClient({ clientId: "shell-a" }).navigate("calendar", {
				expectedRevision: 17,
			}),
		).resolves.toBe(true);

		const [, init] = fetchMock.mock.calls[1] as [
			RequestInfo | URL,
			RequestInit,
		];
		expect(JSON.parse(String(init.body))).toMatchObject({
			expectedRevision: 17,
			clientId: "shell-a",
		});
		expect(init.headers).toMatchObject({
			"X-ElizaOS-Client-Id": "shell-a",
		});
		const [, currentInit] = fetchMock.mock.calls[0] as [
			RequestInfo | URL,
			RequestInit,
		];
		expect(currentInit.headers).toMatchObject({
			"X-ElizaOS-Client-Id": "shell-a",
		});
	});

	it("keeps snapshot and navigate requests isolated between shell clients", async () => {
		const requests: Array<{
			clientId: string | null;
			body?: Record<string, unknown>;
			url: string;
		}> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const clientId = new Headers(init?.headers).get("X-ElizaOS-Client-Id");
				const body =
					typeof init?.body === "string"
						? (JSON.parse(init.body) as Record<string, unknown>)
						: undefined;
				requests.push({ url, clientId, ...(body ? { body } : {}) });

				if (url.endsWith("/api/views/current")) {
					return jsonResponse({
						currentView: null,
						revision: clientId === "shell-a" ? 11 : 29,
					});
				}
				return jsonResponse({ ok: true });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const [snapshotA, snapshotB] = await Promise.all([
			getCurrentViewSnapshot("shell-a"),
			getCurrentViewSnapshot("shell-b"),
		]);
		await Promise.all([
			createViewsClient({ clientId: "shell-a" }).navigate("calendar", {
				expectedRevision: snapshotA.revision,
			}),
			createViewsClient({ clientId: "shell-b" }).navigate("notes", {
				expectedRevision: snapshotB.revision,
			}),
		]);

		expect(requests).toEqual([
			{
				url: "http://127.0.0.1:3456/api/views/current",
				clientId: "shell-a",
			},
			{
				url: "http://127.0.0.1:3456/api/views/current",
				clientId: "shell-b",
			},
			{
				url: "http://127.0.0.1:3456/api/views/calendar/navigate",
				clientId: "shell-a",
				body: expect.objectContaining({
					clientId: "shell-a",
					expectedRevision: 11,
				}),
			},
			{
				url: "http://127.0.0.1:3456/api/views/notes/navigate",
				clientId: "shell-b",
				body: expect.objectContaining({
					clientId: "shell-b",
					expectedRevision: 29,
				}),
			},
		]);
	});
});
