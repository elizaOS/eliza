/**
 * Exercises subview discovery and navigation through the real VIEWS consumers
 * with deterministic registry data and mocked loopback transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewsAction } from "./views.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { runViewsList } from "./views-list.js";

const coreMock = vi.hoisted(() => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	resolveServerOnlyPort: vi.fn(() => 3456),
	hasOwnerAccess: vi.fn(async () => true),
	formatError: (error: unknown): string =>
		error instanceof Error ? error.message : String(error),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return { ...actual, ...coreMock };
});

vi.mock("@elizaos/shared/runtime-env", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@elizaos/shared/runtime-env")>();
	return { ...actual, resolveServerOnlyPort: coreMock.resolveServerOnlyPort };
});

const REGISTRY: ViewSummary[] = [
	{
		id: "settings",
		label: "Settings",
		description: "Configuration, plugins, credentials, and preferences",
		path: "/settings",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["configuration", "preferences"],
		visibleInManager: true,
	},
	{
		id: "wallet",
		label: "Wallet",
		description: "Non-custodial wallet inventory",
		path: "/wallet",
		pluginName: "@elizaos/plugin-wallet:ui",
		available: true,
		viewType: "gui",
		tags: ["finance", "crypto", "wallet"],
		visibleInManager: true,
	},
];

function message(text: string, roomId = "room-1") {
	return {
		entityId: "user-1",
		roomId,
		agentId: "agent-1",
		content: { text },
	};
}

function clientFor(views: ViewSummary[]): ViewsClient {
	return {
		listViews: vi.fn(async () => views),
		getCurrentView: vi.fn(async () => null),
	} as unknown as ViewsClient;
}

describe("VIEWS subview navigation", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true })),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it.each([
		{ view: "settings", options: { subview: "voice" }, expected: "voice" },
		{ view: "settings", options: { subview: "model" }, expected: "ai-model" },
		{
			view: "settings",
			options: { section: "connectors" },
			expected: "connectors",
		},
		{ view: "settings", options: {}, expected: undefined },
		{ view: "wallet", options: { subview: "model" }, expected: "model" },
	])(
		"routes $view with $options to section $expected",
		async ({ view, options, expected }) => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => true),
			});
			const result = await action.handler(
				{ agentId: "agent-1" } as never,
				message(`open ${view}`) as never,
				undefined,
				{ action: "show", view, ...options },
				vi.fn(),
			);
			expect(result?.success).toBe(true);
			expect(result?.values?.subview).toBe(expected);
			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, request] = vi.mocked(fetch).mock.calls[0];
			expect(url).toBe(`http://127.0.0.1:3456/api/views/${view}/navigate`);
			expect(request?.method).toBe("POST");
			const body = JSON.parse(String(request?.body));
			if (expected === undefined) expect(body).not.toHaveProperty("subview");
			else expect(body.subview).toBe(expected);
		},
	);
});

describe("VIEWS list — surfaces subviews for discoverable sections (#9945)", () => {
	it("returns an internal inventory with subviews attached to its data", async () => {
		const client = clientFor(REGISTRY);
		const result = await runViewsList({ client });
		expect(result.success).toBe(true);
		expect(result.transcriptVisibility).toBe("internal");
		expect(result.text).toContain("subviews[");
		expect(result.text).toMatch(/voice:Voice/);
		const views = (result.data as { views: Array<Record<string, unknown>> })
			.views;
		const settings = views.find((v) => v.id === "settings");
		expect(settings?.subviews).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "voice" }),
				expect.objectContaining({ id: "ai-model" }),
			]),
		);
		const wallet = views.find((v) => v.id === "wallet");
		expect(wallet?.subviews).toBeUndefined();
	});
});
