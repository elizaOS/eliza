/**
 * Exercises the fail-closed envelope block inside `wrapSingleTurnVisibleCallback`
 * (services/message) — the per-turn visible delivery seam every action callback,
 * early reply, and terminal reply funnels through. A response whose text carries
 * security-envelope material must reach the connector as the leak notice, never
 * as the armor. Mock runtime with a reportError spy.
 */
import { describe, expect, it, vi } from "vitest";
import { wrapExternalContent } from "../../security/external-content";
import { ENVELOPE_LEAK_NOTICE } from "../../security/outbound-envelope-guard";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { HandlerCallback, Memory } from "../../types";
import { wrapSingleTurnVisibleCallback } from "../message";

function makeRuntime() {
	return createMockRuntime({
		agentId: "agent" as never,
		character: { name: "Example" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		} as never,
		useModel: vi.fn(),
		reportError: vi.fn(),
	});
}

const message = {
	id: "message",
	roomId: "room",
	entityId: "user",
} as unknown as Memory;

describe("visible-callback envelope block", () => {
	it("replaces a leaked envelope reply with the notice and reports it", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const runtime = makeRuntime();
		const leaked = wrapExternalContent("can u host it pls", {
			source: "api",
			includeWarning: true,
		});

		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({ text: leaked }, "REPLY");

		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: ENVELOPE_LEAK_NOTICE }),
			"REPLY",
		);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"outbound-envelope-guard",
			expect.any(Error),
			expect.objectContaining({ seam: "visible-callback" }),
		);
	});

	it("blocks quoted and case-variant marker echoes in replies", async () => {
		for (const text of [
			'earlier you sent "<<<EXTERNAL_UNTRUSTED_CONTENT>>>" to me',
			"i think <<<external_untrusted_content>>> means something",
		]) {
			const callback: HandlerCallback = vi.fn(async () => []);
			const runtime = makeRuntime();
			const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
			await wrapped?.({ text }, "REPLY");
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({ text: ENVELOPE_LEAK_NOTICE }),
				"REPLY",
			);
		}
	});

	it("delivers clean replies untouched without reporting", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const runtime = makeRuntime();
		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({ text: "your site is live!" }, "REPLY");

		expect(callback).toHaveBeenCalledWith(
			{ text: "your site is live!" },
			"REPLY",
		);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});
});
