/**
 * Subview deep-linking coverage for the VIEWS action (#9945).
 *
 * The client can already deep-link a Settings sub-section; these tests pin the
 * agent-side parity: the VIEWS `subview` (alias `section`) param is threaded
 * into the `POST /api/views/:id/navigate` body, resolved through the SAME
 * canonical client token→section map (`resolveSettingsSectionToken`) the slash
 * menu uses, and surfaced on the action result + the list provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subviewsForView } from "./settings-subviews.js";
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
	return { ...coreMock, getUserMessageText: actual.getUserMessageText };
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
		pluginName: "@elizaos/plugin-wallet-ui",
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

interface CapturedNavigate {
	id: string;
	body: Record<string, unknown>;
}

/** Capture each navigate POST id + parsed JSON body. */
function installNavigateCapture(): { navigated: CapturedNavigate[] } {
	const navigated: CapturedNavigate[] = [];
	vi.mocked(globalThis.fetch).mockImplementation(
		async (url: unknown, init?: unknown) => {
			const requestUrl = String(url);
			const match = /\/api\/views\/([^/?]+)\/navigate/.exec(requestUrl);
			if (match) {
				const rawBody = (init as { body?: unknown } | undefined)?.body;
				const body =
					typeof rawBody === "string"
						? (JSON.parse(rawBody) as Record<string, unknown>)
						: {};
				navigated.push({ id: decodeURIComponent(match[1]), body });
			}
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ ok: true }),
			} as Response;
		},
	);
	return { navigated };
}

async function runShow(
	views: ViewSummary[],
	text: string,
	options?: Record<string, unknown>,
) {
	const action = createViewsAction({
		client: clientFor(views),
		hasOwnerAccess: vi.fn(async () => true),
	});
	const callback = vi.fn();
	const result = await action.handler(
		{ agentId: "agent-1" } as never,
		message(text) as never,
		undefined,
		options,
		callback,
	);
	return { result, callback };
}

describe("VIEWS action — subview deep-linking (#9945)", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("threads a canonical settings section id into the navigate body + result", async () => {
		const { navigated } = installNavigateCapture();
		const { result } = await runShow(REGISTRY, "open settings", {
			action: "show",
			view: "settings",
			subview: "voice",
		});
		expect(result?.success).toBe(true);
		expect(navigated).toHaveLength(1);
		expect(navigated[0].id).toBe("settings");
		expect(navigated[0].body.subview).toBe("voice");
		expect(result?.values?.subview).toBe("voice");
	});

	it("resolves a friendly token via the shared resolveSettingsSectionToken map", async () => {
		const { navigated } = installNavigateCapture();
		// "model" / "providers" are aliases for the canonical "ai-model" section.
		const { result } = await runShow(REGISTRY, "open settings", {
			action: "show",
			view: "settings",
			subview: "model",
		});
		expect(navigated[0].body.subview).toBe("ai-model");
		expect(result?.values?.subview).toBe("ai-model");
	});

	it("accepts `section` as an alias for `subview`", async () => {
		const { navigated } = installNavigateCapture();
		await runShow(REGISTRY, "open settings", {
			action: "show",
			view: "settings",
			section: "connectors",
		});
		expect(navigated[0].body.subview).toBe("connectors");
	});

	it("omits subview from the body when none is supplied", async () => {
		const { navigated } = installNavigateCapture();
		await runShow(REGISTRY, "open settings", {
			action: "show",
			view: "settings",
		});
		expect(navigated[0].body).not.toHaveProperty("subview");
	});

	it("does not apply settings token resolution to non-settings views", async () => {
		const { navigated } = installNavigateCapture();
		// "model" is a settings alias, but for the wallet view it is passed through
		// verbatim (no cross-view section map exists).
		await runShow(REGISTRY, "open wallet", {
			action: "show",
			view: "wallet",
			subview: "model",
		});
		expect(navigated[0].id).toBe("wallet");
		expect(navigated[0].body.subview).toBe("model");
	});
});

describe("subviewsForView — addressable sub-sections (#9945)", () => {
	it("returns the canonical settings sections (id + label) from SETTINGS_SECTION_META", () => {
		const subviews = subviewsForView("settings");
		expect(subviews).toBeDefined();
		expect(subviews?.length).toBeGreaterThan(0);
		// Canonical ids/labels sourced from settings-section-meta.
		expect(subviews).toContainEqual({ id: "voice", label: "Voice" });
		expect(subviews).toContainEqual({
			id: "ai-model",
			label: "Models & Providers",
		});
		// Every entry resolvable as a settings section id.
		for (const sv of subviews ?? []) {
			expect(typeof sv.id).toBe("string");
			expect(typeof sv.label).toBe("string");
		}
	});

	it("returns undefined for views without addressable sub-sections", () => {
		expect(subviewsForView("wallet")).toBeUndefined();
		expect(subviewsForView("chat")).toBeUndefined();
	});
});

describe("VIEWS list — surfaces subviews for discoverable sections (#9945)", () => {
	it("emits a subviews line for the settings view and attaches them to data", async () => {
		const client = clientFor(REGISTRY);
		const callback = vi.fn();
		const result = await runViewsList({ client, callback });
		expect(result.success).toBe(true);
		expect(result.text).toContain("subviews[");
		expect(result.text).toMatch(/voice:Voice/);
		const views = (result.data as { views: Array<Record<string, unknown>> })
			.views;
		const settings = views.find((v) => v.id === "settings");
		expect(settings?.subviews).toBeDefined();
		const wallet = views.find((v) => v.id === "wallet");
		expect(wallet?.subviews).toBeUndefined();
	});
});
