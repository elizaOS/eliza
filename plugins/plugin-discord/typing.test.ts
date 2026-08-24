import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTypingController } from "./typing";

function makeChannel(sendTyping?: () => unknown) {
	return { sendTyping: sendTyping ?? vi.fn() };
}

describe("createTypingController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends typing immediately on start", () => {
		const channel = makeChannel();
		const controller = createTypingController(channel as never);
		controller.start();
		expect(channel.sendTyping).toHaveBeenCalledTimes(1);
	});

	it("repeats the typing heartbeat every 9 seconds", () => {
		const channel = makeChannel();
		const controller = createTypingController(channel as never);
		controller.start();
		vi.advanceTimersByTime(9000);
		expect(channel.sendTyping).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(9000);
		expect(channel.sendTyping).toHaveBeenCalledTimes(3);
	});

	it("stops the heartbeat at the default 20-minute TTL", () => {
		const channel = makeChannel();
		const controller = createTypingController(channel as never);
		controller.start();
		vi.advanceTimersByTime(20 * 60 * 1000);
		const callsAtTtl = channel.sendTyping.mock.calls.length;
		vi.advanceTimersByTime(60_000);
		expect(channel.sendTyping.mock.calls.length).toBe(callsAtTtl);
	});

	it("honors a custom max duration", () => {
		const channel = makeChannel();
		const controller = createTypingController(channel as never, 30_000);
		controller.start();
		vi.advanceTimersByTime(30_000);
		const callsAtTtl = channel.sendTyping.mock.calls.length;
		vi.advanceTimersByTime(30_000);
		expect(channel.sendTyping.mock.calls.length).toBe(callsAtTtl);
	});

	it("ignores repeated start calls", () => {
		const channel = makeChannel();
		const controller = createTypingController(channel as never);
		controller.start();
		controller.start();
		vi.advanceTimersByTime(9000);
		// One heartbeat interval only: immediate + one tick.
		expect(channel.sendTyping.mock.calls.length).toBe(2);
	});

	it("stop is idempotent and halts further heartbeats", () => {
		const channel = makeChannel();
		const controller = createTypingController(channel as never);
		controller.start();
		vi.advanceTimersByTime(9000);
		controller.stop();
		controller.stop();
		const callsAtStop = channel.sendTyping.mock.calls.length;
		vi.advanceTimersByTime(60_000);
		expect(channel.sendTyping.mock.calls.length).toBe(callsAtStop);
	});

	it("start after stop is a no-op", () => {
		const channel = makeChannel();
		const controller = createTypingController(channel as never);
		controller.start();
		controller.stop();
		controller.start();
		vi.advanceTimersByTime(9000);
		expect(channel.sendTyping.mock.calls.length).toBe(1);
	});

	it("swallows synchronous sendTyping failures", () => {
		const channel = makeChannel(() => {
			throw new Error("discord unavailable");
		});
		const controller = createTypingController(channel as never);
		expect(() => controller.start()).not.toThrow();
		expect(() => controller.stop()).not.toThrow();
	});

	it("swallows rejected sendTyping promises", () => {
		const channel = makeChannel(() => Promise.reject(new Error("network")));
		const controller = createTypingController(channel as never);
		expect(() => controller.start()).not.toThrow();
		controller.stop();
	});

	it("works when the channel does not implement sendTyping", () => {
		const controller = createTypingController({} as never);
		expect(() => controller.start()).not.toThrow();
		expect(() => controller.stop()).not.toThrow();
	});
});
