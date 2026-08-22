/** Date ISO serialization safety for scheduleDraftSend.ts — fail-fast on invalid times. */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ElizaError } from "../../../../errors.ts";
import {
	formatSendAtIso,
	scheduleDraftSendAction,
} from "./scheduleDraftSend.ts";

describe("scheduleDraftSend date safety", () => {
	afterEach(() => vi.restoreAllMocks());

	test("valid timestamp formats to valid ISO-8601 string", () => {
		const ts = 1700000000000;
		const iso = formatSendAtIso(ts);
		expect(iso).toBe("2023-11-14T22:13:20.000Z");
	});

	test("NaN timestamp throws typed ElizaError (fail-fast, no success string)", () => {
		expect(() => formatSendAtIso(Number.NaN)).toThrow(ElizaError);
		try {
			formatSendAtIso(Number.NaN);
		} catch (e) {
			expect((e as ElizaError).code).toBe(
				"MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
			);
			expect(String((e as ElizaError).message)).toMatch(/not finite/i);
		}
	});

	test("Infinity timestamp throws typed ElizaError", () => {
		expect(() => formatSendAtIso(Number.POSITIVE_INFINITY)).toThrow(ElizaError);
		expect(() => formatSendAtIso(Number.NEGATIVE_INFINITY)).toThrow(ElizaError);
	});

	test("out-of-range epoch milliseconds throws typed ElizaError (no fallback string)", () => {
		const outOfRange = 8640000000000001; // Exceeds ECMAScript max Date range
		expect(() => formatSendAtIso(outOfRange)).toThrow(ElizaError);
		try {
			formatSendAtIso(outOfRange);
		} catch (e) {
			expect((e as ElizaError).code).toBe(
				"MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
			);
		}
	});

	test("handler rejects an invalid time before scheduling or reporting success", async () => {
		const draftId = "draft-123";
		const outOfRange = 8640000000000001;
		const mockStore = {
			getDraft: vi.fn().mockReturnValue({ id: draftId }),
		} as never;
		const scheduleDraftSend = vi.fn();
		const mockService = {
			getStore: () => mockStore,
			scheduleDraftSend,
		} as never;
		const mod = await import("../triage-service.ts");
		vi.spyOn(mod, "getDefaultTriageService").mockReturnValue(mockService);
		const runtime = { agentId: "agent-1" } as never;
		const message = { entityId: "e1", roomId: "r1", content: {} } as never;
		const callback = vi.fn();
		await expect(
			scheduleDraftSendAction.handler(
				runtime,
				message,
				undefined,
				{
					parameters: { draftId, sendAtMs: outOfRange },
				} as never,
				callback,
			),
		).rejects.toMatchObject({
			code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
		});
		expect(scheduleDraftSend).not.toHaveBeenCalled();
		expect(mockStore.getDraft).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});
});
