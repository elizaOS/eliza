import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDiscordIngressReadiness } from "./readiness";

describe("waitForDiscordIngressReadiness", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves immediately when ready is null or undefined", async () => {
		await expect(waitForDiscordIngressReadiness(null)).resolves.toBeUndefined();
		await expect(
			waitForDiscordIngressReadiness(undefined),
		).resolves.toBeUndefined();
	});

	it("resolves when the ready promise settles first", async () => {
		await expect(
			waitForDiscordIngressReadiness(Promise.resolve()),
		).resolves.toBeUndefined();
	});

	it("rejects with a fail-closed timeout error when hydration never settles", async () => {
		vi.useFakeTimers();
		const never = new Promise<void>(() => {});
		const pending = waitForDiscordIngressReadiness(never, 1_000);

		const assertion = expect(pending).rejects.toThrow(
			"Discord ready-time identity hydration timed out after 1000ms",
		);
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
	});

	it("honors a custom timeout window in the error message", async () => {
		vi.useFakeTimers();
		const never = new Promise<void>(() => {});
		const pending = waitForDiscordIngressReadiness(never, 42);

		const assertion = expect(pending).rejects.toThrow("timed out after 42ms");
		await vi.advanceTimersByTimeAsync(42);
		await assertion;
	});

	it("clears the timer once the ready promise wins the race", async () => {
		vi.useFakeTimers();
		const gate = vi.fn<void, []>();
		const ready = new Promise<void>((resolve) => {
			gate.mockImplementation(resolve);
		});
		const pending = waitForDiscordIngressReadiness(ready, 5_000);
		gate();
		await pending;

		// No dangling timer should remain after a successful settle.
		const remaining = vi.getTimerCount();
		expect(remaining).toBe(0);
	});

	it("propagates an underlying ready failure without wrapping", async () => {
		await expect(
			waitForDiscordIngressReadiness(Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
	});
});
