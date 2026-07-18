/**
 * Verifies that completed navigation state cannot leak a second acknowledgement
 * into a later turn, while an explicit new target still reaches Stage-1 as
 * factual routing context. The loopback current-view boundary is mocked; the
 * compose hook and provider are real.
 */
import type {
	IAgentRuntime,
	Memory,
	PipelineHookContextForPhase,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getCurrentView: vi.fn() }));
vi.mock("../actions/views-client.js", () => ({
	createViewsClient: () => ({ getCurrentView: h.getCurrentView }),
	readViewClientId: () => undefined,
}));

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

function msg(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		entityId: "22222222-2222-2222-2222-222222222222",
		roomId: ROOM_ID,
		content: { text },
	} as Memory;
}

describe("view-switch response context ownership", () => {
	beforeEach(() => h.getCurrentView.mockReset());

	it("does not replay a completed switch acknowledgement on the next turn", () => {
		const ctx = makeComposeCtx("thanks!");
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).not.toContain("current_view");
	});

	it("makes a new explicit target authoritative over the recently active view", async () => {
		const ctx = makeComposeCtx("switch to notes");
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).toContain("current_view");

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
			msg("switch to notes"),
			{ values: {}, data: {}, text: "" },
		);
		expect(result.text).toContain("Requested view target: Notes");
		expect(result.text).toContain("authoritative for this turn");
		expect(result.text).not.toContain("acknowledge");
		expect(result.values?.switchingToViewId).toBe("notes");
	});

	it("does not inject current-view state into an unrelated ordinary turn", () => {
		const ctx = makeComposeCtx("what's the weather like today");
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).not.toContain("current_view");
	});
});
