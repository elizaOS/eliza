/**
 * View-switch signal tests for tracking recent navigation events.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	__resetViewSwitchSignal,
	clearViewSwitch,
	hasFreshViewSwitch,
	markViewSwitch,
	VIEW_SWITCH_SIGNAL_FRESH_MS,
} from "./view-switch-signal.js";

describe("view-switch-signal", () => {
	afterEach(() => __resetViewSwitchSignal());

	it("reports a freshly recorded switch as fresh within the window", () => {
		markViewSwitch("room-1", 1_000);
		expect(hasFreshViewSwitch("room-1", 1_000)).toBe(true);
		expect(
			hasFreshViewSwitch("room-1", 1_000 + VIEW_SWITCH_SIGNAL_FRESH_MS - 1),
		).toBe(true);
	});

	it("expires a switch after the freshness window", () => {
		markViewSwitch("room-1", 1_000);
		expect(
			hasFreshViewSwitch("room-1", 1_000 + VIEW_SWITCH_SIGNAL_FRESH_MS + 1),
		).toBe(false);
	});

	it("is keyed per room and ignores unknown / undefined rooms", () => {
		markViewSwitch("room-1", 1_000);
		expect(hasFreshViewSwitch("room-2", 1_000)).toBe(false);
		expect(hasFreshViewSwitch(undefined, 1_000)).toBe(false);
		markViewSwitch(undefined, 1_000); // no-op
		expect(hasFreshViewSwitch("room-3", 1_000)).toBe(false);
	});

	it("clears a recorded switch", () => {
		markViewSwitch("room-1", 1_000);
		clearViewSwitch("room-1");
		expect(hasFreshViewSwitch("room-1", 1_000)).toBe(false);
	});
});
/**
 * View-switch signal tests for tracking recent navigation events.
 */
