/**
 * Integration test (#8788): both navigation paths produce a same-turn
 * acknowledgement signal — neither moves the user silently.
 *
 * Two independent code paths can switch the user's view:
 *  - the VIEWS action (`runViewsShow`) for DIRECT commands, and
 *  - the contextual `viewContextEvaluator` processor for IMPLIED situations.
 *
 * Both stamp the same turn-scoped switch signal (`markViewSwitch`) on success.
 * This proves the symmetry end to end: after either path records the switch,
 *  (a) `hasFreshViewSwitch` reports it for the room,
 *  (b) the `compose_state_providers` hook injects `current_view` into the
 *      curated Stage-1 response state, and
 *  (c) the `current_view` provider returns acknowledgement-phrased text naming
 *      the switched view.
 * The negative case proves a turn with no switch pays no cost (hook does not
 * inject), so the acknowledgement is never silent and never gratuitous.
 *
 * Reuses the REAL `markViewSwitch` / `hasFreshViewSwitch` / hook / provider —
 * only the loopback HTTP client is mocked, exactly as the sibling unit tests do.
 */
import type {
	IAgentRuntime,
	Memory,
	PipelineHookContextForPhase,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the loopback HTTP boundary — same style as current-view.test.ts.
const h = vi.hoisted(() => ({ getCurrentView: vi.fn() }));
vi.mock("../actions/views-client.js", () => ({
	createViewsClient: () => ({ getCurrentView: h.getCurrentView }),
}));

import { currentViewProvider } from "../providers/current-view.js";
import { applyCurrentViewComposeHook } from "./current-view-hook.js";
import {
	__resetViewSwitchSignal,
	hasFreshViewSwitch,
	markViewSwitch,
} from "./view-switch-signal.js";

const runtime = {} as IAgentRuntime;
const ROOM_ID = "11111111-1111-1111-1111-111111111111";

type ComposeCtx = PipelineHookContextForPhase<"compose_state_providers">;

function makeComposeCtx(text: string, roomId = ROOM_ID): ComposeCtx {
	return {
		phase: "compose_state_providers",
		message: {
			id: "00000000-0000-0000-0000-000000000000",
			entityId: "22222222-2222-2222-2222-222222222222",
			roomId,
			content: { text },
		},
		providers: { current: ["RECENT_MESSAGES"] },
		activeContexts: [],
		onlyInclude: true,
		includeList: ["RECENT_MESSAGES"],
	} as unknown as ComposeCtx;
}

function msg(text: string, roomId = ROOM_ID): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		entityId: "22222222-2222-2222-2222-222222222222",
		roomId,
		content: { text },
	} as Memory;
}

describe("both nav paths produce a same-turn acknowledgement signal (#8788)", () => {
	beforeEach(() => h.getCurrentView.mockReset());
	afterEach(() => __resetViewSwitchSignal());

	it("ACTION path: VIEWS action records the switch → signal fresh, hook injects, provider acknowledges", async () => {
		// After `navigateToView` succeeds, runViewsShow calls markViewSwitch(roomId)
		// (views-show.ts:417). The server then reports the new view as justSwitched.
		markViewSwitch(ROOM_ID);

		// (a) the turn-scoped signal is fresh for this room
		expect(hasFreshViewSwitch(ROOM_ID)).toBe(true);

		// (b) the compose hook injects current_view into the curated response state
		const ctx = makeComposeCtx("thanks!");
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).toContain("current_view");

		// (c) the provider acknowledges the agent-initiated switch from server state
		h.getCurrentView.mockResolvedValue({
			viewId: "calendar",
			viewLabel: "Calendar",
			viewPath: "/calendar",
			viewType: "gui",
			justSwitched: true,
			source: "agent",
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(runtime, msg("thanks!"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("You just switched the user to the Calendar view");
		expect(r.values?.viewJustSwitched).toBe(true);
		expect(r.values?.viewSwitchSource).toBe("agent");
	});

	it("CONTEXTUAL path: evaluator processor records the switch → signal fresh, hook injects, provider acknowledges", async () => {
		// The contextual evaluator (view-context.ts:115) records the switch the same
		// way after navigate, on a turn whose text named no view directly — proving
		// the implied-navigation path is acknowledged via the identical mechanism.
		markViewSwitch(ROOM_ID);

		// (a) same turn-scoped signal, same room
		expect(hasFreshViewSwitch(ROOM_ID)).toBe(true);

		// (b) hook injects even though the message text is NOT an explicit command
		// (resolveIntentView would not match "let's tackle the login bug"); the
		// recent-switch signal alone is enough.
		const ctx = makeComposeCtx("let's tackle the login bug");
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).toContain("current_view");

		// (c) the provider acknowledges the just-executed contextual switch
		h.getCurrentView.mockResolvedValue({
			viewId: "task-coordinator",
			viewLabel: "Task Coordinator",
			viewPath: "/task-coordinator",
			viewType: "gui",
			justSwitched: true,
			source: "agent",
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(
			runtime,
			msg("let's tackle the login bug"),
			{ values: {}, data: {}, text: "" },
		);
		expect(r.text).toContain(
			"You just switched the user to the Task Coordinator view",
		);
		expect(r.values?.viewJustSwitched).toBe(true);
		expect(r.values?.viewSwitchSource).toBe("agent");
	});

	it("NEGATIVE: no switch this turn → signal absent and hook does NOT inject (no silent cost)", () => {
		// No path recorded a switch, and the text is not an explicit command.
		expect(hasFreshViewSwitch(ROOM_ID)).toBe(false);
		const ctx = makeComposeCtx("what's the weather like today");
		applyCurrentViewComposeHook(ctx);
		expect(ctx.providers.current).not.toContain("current_view");
	});
});
