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
	coreMock.resolveServerOnlyPort.mockClear();
});

describe("views client", () => {
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

		await expect(createViewsClient().getCurrentView()).resolves.toEqual({
			viewId: "smartglasses",
			viewPath: "/apps/smartglasses",
			viewLabel: "Smartglasses",
			viewType: "xr",
			action: "open",
			updatedAt: "2026-05-31T08:00:00.000Z",
		});
	});
});
