/**
 * Views client tests for loopback API normalization and request construction.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewsClient } from "./views-client.js";

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
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(createViewsClient().getCurrentView()).resolves.toMatchObject({
			viewId: "settings",
			subview: "voice",
		});
	});
});
