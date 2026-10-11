import { afterEach, describe, expect, it, vi } from "vitest";
import { type BeforeQuitEvent, createQuitGate } from "./quit-gate";

/**
 * Mirrors Electrobun 1.18.1 `Utils.quit()`: emit `before-quit` synchronously,
 * honour an `allow: false` veto, otherwise tear the process down without
 * returning to the event loop.
 */
function createHost() {
	let handler: ((event: BeforeQuitEvent) => void) | null = null;
	let quitting = false;
	const host = {
		exited: false,
		quitCalls: 0,
		onBeforeQuit(next: (event: BeforeQuitEvent) => void) {
			handler = next;
		},
		quit() {
			if (quitting) return;
			quitting = true;
			host.quitCalls += 1;
			const event: BeforeQuitEvent = {};
			handler?.(event);
			if (event.response?.allow === false) {
				quitting = false;
				return;
			}
			host.exited = true;
		},
	};
	return host;
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createQuitGate", () => {
	it("vetoes a native quit until cleanup settles, then quits", async () => {
		const host = createHost();
		const cleanup = deferred();
		const runCleanup = vi.fn(() => cleanup.promise);
		const gate = createQuitGate({ runCleanup, quit: host.quit });
		host.onBeforeQuit(gate.handleBeforeQuit);

		host.quit();
		await Promise.resolve();
		await Promise.resolve();

		expect(host.exited).toBe(false);
		expect(runCleanup).toHaveBeenCalledTimes(1);

		// A second quit while cleanup is running is vetoed too and does not
		// start cleanup again.
		host.quit();
		expect(host.exited).toBe(false);
		expect(runCleanup).toHaveBeenCalledTimes(1);

		cleanup.resolve();
		await gate.requestQuit();

		expect(host.exited).toBe(true);
	});

	it("still quits when cleanup rejects", async () => {
		const host = createHost();
		const onCleanupError = vi.fn();
		const failure = new Error("disposer failed");
		const gate = createQuitGate({
			runCleanup: () => Promise.reject(failure),
			quit: host.quit,
			onCleanupError,
		});
		host.onBeforeQuit(gate.handleBeforeQuit);

		host.quit();
		await gate.requestQuit();

		expect(onCleanupError).toHaveBeenCalledWith(failure);
		expect(host.exited).toBe(true);
	});

	it("quits after the deadline when cleanup never settles", async () => {
		vi.useFakeTimers();
		const host = createHost();
		const onDeadline = vi.fn();
		const gate = createQuitGate({
			runCleanup: () => new Promise<void>(() => {}),
			quit: host.quit,
			deadlineMs: 1_000,
			onDeadline,
		});
		host.onBeforeQuit(gate.handleBeforeQuit);

		host.quit();
		await vi.advanceTimersByTimeAsync(999);
		expect(host.exited).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(onDeadline).toHaveBeenCalledWith(1_000);
		expect(host.exited).toBe(true);
	});

	it("lets the quit through when cleanup already settled elsewhere", () => {
		const host = createHost();
		const runCleanup = vi.fn(() => Promise.resolve());
		const gate = createQuitGate({ runCleanup, quit: host.quit });
		host.onBeforeQuit(gate.handleBeforeQuit);

		gate.markCleanupSettled();
		host.quit();

		expect(host.exited).toBe(true);
		expect(runCleanup).not.toHaveBeenCalled();
	});

	it("runs cleanup once for an explicit quit request", async () => {
		const host = createHost();
		const runCleanup = vi.fn(() => Promise.resolve());
		const gate = createQuitGate({ runCleanup, quit: host.quit });
		host.onBeforeQuit(gate.handleBeforeQuit);

		await Promise.all([gate.requestQuit(), gate.requestQuit()]);

		expect(runCleanup).toHaveBeenCalledTimes(1);
		expect(host.quitCalls).toBe(1);
		expect(host.exited).toBe(true);
	});

	it("starts the relaunched instance after cleanup and before the quit", async () => {
		const host = createHost();
		const cleanup = deferred();
		const order: string[] = [];
		const gate = createQuitGate({
			runCleanup: () =>
				cleanup.promise.then(() => {
					order.push("cleanup");
				}),
			quit: () => {
				order.push("quit");
				host.quit();
			},
		});
		host.onBeforeQuit(gate.handleBeforeQuit);

		const relaunch = gate.requestRelaunch(() => {
			order.push("spawn");
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual([]);

		cleanup.resolve();
		await relaunch;

		expect(order).toEqual(["cleanup", "spawn", "quit"]);
		expect(host.exited).toBe(true);
	});

	it("still starts the relaunched instance when cleanup misses the deadline", async () => {
		const host = createHost();
		const order: string[] = [];
		const gate = createQuitGate({
			runCleanup: () => new Promise<void>(() => {}),
			deadlineMs: 5,
			onDeadline: () => {
				order.push("deadline");
			},
			quit: () => {
				order.push("quit");
				host.quit();
			},
		});
		host.onBeforeQuit(gate.handleBeforeQuit);

		await gate.requestRelaunch(() => {
			order.push("spawn");
		});

		expect(order).toEqual(["deadline", "spawn", "quit"]);
		expect(host.quitCalls).toBe(1);
		expect(host.exited).toBe(true);
	});

	it("starts the replacement once when a relaunch joins a quit in flight", async () => {
		const host = createHost();
		const cleanup = deferred();
		let spawns = 0;
		const gate = createQuitGate({
			runCleanup: () => cleanup.promise,
			quit: host.quit,
		});
		host.onBeforeQuit(gate.handleBeforeQuit);

		const quit = gate.requestQuit();
		const relaunch = gate.requestRelaunch(() => {
			spawns += 1;
		});
		cleanup.resolve();
		await Promise.all([quit, relaunch]);

		expect(spawns).toBe(1);
		expect(host.quitCalls).toBe(1);
		expect(host.exited).toBe(true);
	});
});
