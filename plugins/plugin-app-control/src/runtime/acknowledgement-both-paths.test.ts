/**
 * Verifies that completed navigation state cannot leak a second acknowledgement
 * into a later turn, while a new explicit target still reaches Stage 1.
 */

import type {
	IAgentRuntime,
	Memory,
	PipelineHookContextForPhase,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getCurrentView: vi.fn() }));
vi.mock("../actions/views-client.js", () => ({
	createViewsClient: () => ({ getCurrentView: h.getCurrentView }),
}));

import type { ViewSummary, ViewsClient } from "../actions/views-client.js";
import { runViewsShow } from "../actions/views-show.js";
import { viewCommandShortcutEvaluator } from "../evaluators/view-command-shortcut.js";
import { currentViewProvider } from "../providers/current-view.js";
import { applyCurrentViewComposeHook } from "./current-view-hook.js";

const runtime = { reportError: vi.fn() } as unknown as IAgentRuntime;
const ROOM_ID = "11111111-1111-1111-1111-111111111111";
type ComposeCtx = PipelineHookContextForPhase<"compose_state_providers">;

function makeComposeCtx(text: string): ComposeCtx {
	return {
		phase: "compose_state_providers",
		message: {
			id: "00000000-0000-0000-0000-000000000000",
			entityId: "22222222-2222-2222-2222-222222222222",
			roomId: ROOM_ID,
			content: { text },
		},
		providers: { current: ["RECENT_MESSAGES"] },
		activeContexts: [],
		onlyInclude: true,
		includeList: ["RECENT_MESSAGES"],
	} as unknown as ComposeCtx;
}

function message(
	text: string,
	id = "00000000-0000-0000-0000-000000000000",
): Memory {
	return {
		id,
		entityId: "22222222-2222-2222-2222-222222222222",
		roomId: ROOM_ID,
		content: { text },
	} as Memory;
}

const NOTES_VIEW: ViewSummary = {
	id: "notes",
	label: "Notes",
	path: "/notes",
	pluginName: "simple-views",
	available: true,
	viewType: "gui",
};

const viewsClient = {
	listViews: vi.fn(async () => [NOTES_VIEW]),
	getCurrentView: h.getCurrentView,
	navigate: vi.fn(async () => true),
} as ViewsClient;

function shortcutContext(text: string): ResponseHandlerEvaluatorContext {
	return {
		runtime: { actions: [{ name: "VIEWS" }] },
		message: message(text, "00000000-0000-0000-0000-000000000099"),
		state: {},
		messageHandler: {
			processMessage: "RESPOND",
			plan: { requiresTool: false },
		},
		availableContexts: [],
	} as unknown as ResponseHandlerEvaluatorContext;
}

describe("view-switch response context ownership", () => {
	beforeEach(() => {
		h.getCurrentView.mockReset();
		viewsClient.listViews.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 200 })),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("keeps the open-notes effect internal and leaves the following wyd turn untouched", async () => {
		const callback = vi.fn(async () => []);
		const result = await runViewsShow({
			client: viewsClient,
			message: message("open notes"),
			callback,
		});

		expect(callback).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			modelReplyRequired: true,
		});
		expect(result).not.toHaveProperty("turnComplete");
		expect(result).not.toHaveProperty("userFacingText");
		expect(result).not.toHaveProperty("verifiedUserFacing");
		expect(JSON.parse(result.text ?? "{}")).toMatchObject({
			effect: "view_navigation",
			status: "accepted",
			viewId: "notes",
		});
		expect(fetch).toHaveBeenCalledTimes(1);

		const nextContext = makeComposeCtx("wyd?");
		applyCurrentViewComposeHook(nextContext);
		expect(nextContext.providers.current).not.toContain("current_view");
		expect(
			await viewCommandShortcutEvaluator.shouldRun(shortcutContext("wyd?")),
		).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not replay a completed switch acknowledgement on the next turn", () => {
		const context = makeComposeCtx("wyd?");
		applyCurrentViewComposeHook(context);
		expect(context.providers.current).not.toContain("current_view");
	});

	it("makes a new explicit target authoritative over the recently active view", async () => {
		const context = makeComposeCtx("switch to notes");
		applyCurrentViewComposeHook(context);
		expect(context.providers.current).toContain("current_view");

		h.getCurrentView.mockResolvedValue({
			viewId: "simple-calendar",
			viewLabel: "Simple Calendar",
			viewPath: "/simple-calendar",
			viewType: "gui",
			justSwitched: true,
			source: "agent",
			updatedAt: "x",
		});
		const result = await currentViewProvider.get(
			runtime,
			message("switch to notes"),
			{ values: {}, data: {}, text: "" },
		);
		expect(result.text).toContain("Requested view target: Notes");
		expect(result.text).toContain("authoritative for this turn");
		expect(result.text).not.toContain("acknowledge");
		expect(result.values?.switchingToViewId).toBe("notes");
	});

	it("does not inject current-view state into unrelated ordinary chat", () => {
		const context = makeComposeCtx("what are you doing right now?");
		applyCurrentViewComposeHook(context);
		expect(context.providers.current).not.toContain("current_view");
	});
});
