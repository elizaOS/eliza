/** The system task clock follows the wall clock across a suspend or clock jump. */
import { afterEach, expect, it, vi } from "vitest";
import {
	systemTaskServiceClock,
	WALL_CLOCK_CHECK_MS,
} from "../src/services/task";

afterEach(() => {
	vi.useRealTimers();
});

const T = 1_800_000_000_000;

it("fires at the due time with no clock jump", async () => {
	vi.useFakeTimers({ now: T, toFake: ["setTimeout", "clearTimeout", "Date"] });
	const callback = vi.fn(async () => undefined);
	systemTaskServiceClock.setTimeout(callback, 60_000);
	vi.advanceTimersByTime(59_999);
	expect(callback).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(callback).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(120_000);
	expect(callback).toHaveBeenCalledTimes(1);
});

it("fires within one check after the wall clock passes the due time", async () => {
	vi.useFakeTimers({ now: T, toFake: ["setTimeout", "clearTimeout", "Date"] });
	const callback = vi.fn(async () => undefined);
	systemTaskServiceClock.setTimeout(callback, 60_000);
	vi.advanceTimersByTime(5_000);
	// A 20 minute suspend: wall time moves, monotonic timers do not.
	vi.setSystemTime(Date.now() + 20 * 60_000);
	vi.advanceTimersByTime(WALL_CLOCK_CHECK_MS);
	expect(callback).toHaveBeenCalledTimes(1);
});

it("clearTimeout cancels a long sleep", async () => {
	vi.useFakeTimers({ now: T, toFake: ["setTimeout", "clearTimeout", "Date"] });
	const callback = vi.fn(async () => undefined);
	const handle = systemTaskServiceClock.setTimeout(callback, 60_000);
	vi.advanceTimersByTime(30_500);
	systemTaskServiceClock.clearTimeout(handle);
	vi.advanceTimersByTime(60_000);
	expect(callback).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
