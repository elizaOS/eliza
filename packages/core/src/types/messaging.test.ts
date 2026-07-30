/**
 * Exercises the send-handler evidence contract at its runtime trust boundary,
 * including stale structural shapes and provider/local-persistence splits.
 */

import { describe, expect, it } from "vitest";
import type { Memory, SendHandlerReceipt } from "./index.ts";
import {
	inspectSendHandlerResult,
	isSendHandlerOutcome,
	requireConfirmedSendHandlerDelivery,
} from "./messaging.ts";

const receipt = (
	ids: [string, ...string[]] = ["provider-1"],
): SendHandlerReceipt => ({
	providerMessageIds: ids,
	acceptedAt: 1_780_000_000_000,
	persistence: { status: "persisted", memoryIds: [] },
});

describe("send-handler delivery evidence", () => {
	it("treats legacy void and malformed structural outcomes as unknown", () => {
		expect(inspectSendHandlerResult(undefined)).toMatchObject({
			kind: "unknown",
		});
		const staleOutcome = {
			kind: "delivered",
			providerMessageId: "legacy-provider-1",
			memory: {},
		};
		expect(isSendHandlerOutcome(staleOutcome)).toBe(false);
		expect(inspectSendHandlerResult(staleOutcome as never)).toMatchObject({
			kind: "unknown",
			message: expect.stringContaining("invalid structural"),
		});
	});

	it("keeps every provider id on fresh and replayed deliveries", () => {
		const exactReceipt = receipt(["provider-1", "provider-2"]);
		expect(
			inspectSendHandlerResult({
				kind: "delivered",
				receipt: exactReceipt,
				memories: [],
			}),
		).toEqual({
			kind: "delivered",
			replayed: false,
			receipt: exactReceipt,
			providerMessageId: "provider-2",
			memories: [],
		});
		expect(
			inspectSendHandlerResult({
				kind: "duplicate",
				priorDelivery: "delivered",
				receipt: exactReceipt,
			}),
		).toEqual({
			kind: "delivered",
			replayed: true,
			receipt: exactReceipt,
			providerMessageId: "provider-2",
			memories: [],
		});
	});

	it("preserves partial acceptance on a committed duplicate", () => {
		const exactReceipt = receipt(["provider-prefix-1"]);
		expect(
			inspectSendHandlerResult({
				kind: "duplicate",
				priorDelivery: "partially_delivered",
				receipt: exactReceipt,
			}),
		).toMatchObject({
			kind: "partially_delivered",
			replayed: true,
			receipt: exactReceipt,
			providerMessageId: "provider-prefix-1",
		});
	});

	it("extracts provider identity from a legacy persisted Memory", () => {
		const memory = {
			id: "00000000-0000-4000-8000-000000000001",
			content: { text: "sent" },
			metadata: { platformMessageId: "provider-memory-1" },
		} as Memory;
		expect(inspectSendHandlerResult(memory)).toMatchObject({
			kind: "delivered",
			replayed: false,
			providerMessageId: "provider-memory-1",
			memories: [memory],
		});
	});

	it("rejects zero-evidence, partial, and failed-persistence success claims", () => {
		expect(() => requireConfirmedSendHandlerDelivery(undefined)).toThrow(
			/not confirmed/i,
		);
		expect(() =>
			requireConfirmedSendHandlerDelivery({
				kind: "partially_delivered",
				receipt: receipt(["provider-prefix-1"]),
				memories: [],
				code: "PARTIAL",
				message: "second chunk failed",
			}),
		).toThrow(/not confirmed/i);
		expect(() =>
			requireConfirmedSendHandlerDelivery({
				kind: "delivered",
				receipt: {
					providerMessageIds: ["provider-accepted-1"],
					acceptedAt: 1_780_000_000_000,
					persistence: {
						status: "failed",
						failures: [
							{
								providerMessageId: "provider-accepted-1",
								stage: "memory",
								code: "DB_DOWN",
								message: "database unavailable",
							},
						],
					},
				},
				memories: [],
			}),
		).toThrow(/do not retry blindly/i);
	});
});
