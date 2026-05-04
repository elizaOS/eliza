/**
 * Unit tests for the Discord typing controller.
 *
 * The message handler path has been changed so `typingController.start()` is
 * no longer called proactively when a message arrives. Instead, start() fires
 * only when the runtime actually invokes the handler callback — which happens
 * either via the planner-text preamble (the runtime has committed to
 * responding) or via an action handler's output. This avoids showing
 * "Eliza is typing…" for messages the agent will IGNORE or NONE.
 *
 * These tests cover the controller's own invariants and serve as a regression
 * guard for the "no typing before start()" contract that the message-handler
 * change relies on.
 */

import type { TextChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createTypingController } from "../typing";

function fakeChannel(): TextChannel & { _sentTypingCount: number } {
	let count = 0;
	const channel = {
		sendTyping: vi.fn(async () => {
			count += 1;
		}),
		get _sentTypingCount() {
			return count;
		},
	};
	return channel as unknown as TextChannel & { _sentTypingCount: number };
}

describe("Discord typing controller", () => {
	it("does not send typing on construction — only on start()", () => {
		const channel = fakeChannel();
		createTypingController(channel);
		expect(channel._sentTypingCount).toBe(0);
	});

	it("sends typing immediately when start() is called", () => {
		const channel = fakeChannel();
		const ctrl = createTypingController(channel);
		ctrl.start();
		expect(channel._sentTypingCount).toBe(1);
		ctrl.stop();
	});

	it("is idempotent: start() twice still only fires the initial typing once", () => {
		const channel = fakeChannel();
		const ctrl = createTypingController(channel);
		ctrl.start();
		ctrl.start();
		expect(channel._sentTypingCount).toBe(1);
		ctrl.stop();
	});

	it("does not send typing after stop() is called", () => {
		const channel = fakeChannel();
		const ctrl = createTypingController(channel);
		ctrl.stop();
		ctrl.start();
		expect(channel._sentTypingCount).toBe(0);
	});

	it("stop() before start() cancels any future starts (prevents late typing for IGNORE/NONE)", () => {
		// This is the invariant the new message-handler path relies on: if we
		// decide to IGNORE a message, we never call start() — and even if
		// something fires a deferred start after stop(), no typing fires.
		const channel = fakeChannel();
		const ctrl = createTypingController(channel);
		ctrl.stop();
		ctrl.start();
		ctrl.start();
		expect(channel._sentTypingCount).toBe(0);
	});
});
