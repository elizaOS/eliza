/**
 * The typing indicator starts when the message service reports the Stage-1
 * respond decision, not when the final reply reaches the send callback, and it
 * never starts or lingers for a turn that does not answer. Drives the real
 * MessageManager with Discord network objects stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMessageManagerHarness } from "../test/helpers/message-manager-harness.ts";

describe("Discord typing at the respond decision", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts typing at the decision, before the reply, and does not restart it on send", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let typingAtDecision = -1;
		let typingBeforeReply = -1;
		const harness = makeMessageManagerHarness({
			inboundId: "666000000000000005",
			content: "hello",
			handleMessage: async (_message, callback, options) => {
				options?.onResponseDecision?.();
				typingAtDecision = harness.sendTyping.mock.calls.length;
				await new Promise((resolve) => setTimeout(resolve, 5));
				typingBeforeReply = harness.sendTyping.mock.calls.length;
				await callback({ text: "a planned reply", source: "discord" });
			},
		});
		await harness.run();
		expect(typingAtDecision).toBe(1);
		expect(typingBeforeReply).toBe(1);
		expect(harness.sends).toEqual(["a planned reply"]);
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
		// Delivery stopped the heartbeat: no typing after the reply landed.
		vi.advanceTimersByTime(60_000);
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
	});

	it("never types for a turn that ignores the message", async () => {
		const harness = makeMessageManagerHarness({
			inboundId: "666000000000000006",
			content: "hello",
			handleMessage: async () => {},
		});
		await harness.run();
		expect(harness.sendTyping).not.toHaveBeenCalled();
		expect(harness.sends).toEqual([]);
	});

	it("stops a decision-started indicator when the turn ends without a reply", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const harness = makeMessageManagerHarness({
			inboundId: "666000000000000007",
			content: "hello",
			handleMessage: async (_message, _callback, options) => {
				options?.onResponseDecision?.();
			},
		});
		await harness.run();
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_000);
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
		expect(harness.sends).toEqual([]);
	});
});
