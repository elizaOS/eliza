/**
 * Deterministic unit coverage for complete admission, owner authorization,
 * expiry, and capacity behavior of the private rejected-input store.
 */

import { describe, expect, it } from "vitest";
import { RejectedModelInputStore } from "./rejected-model-input-store";

describe("RejectedModelInputStore", () => {
	it("returns a complete request only to its owning agent and conversation", () => {
		const store = new RejectedModelInputStore();
		const request = JSON.stringify({ messages: [{ content: "HEAD-TAIL" }] });
		const receipt = store.put({
			ownerAgentId: "agent-a",
			ownerConversationId: "room-a",
			serializedRequest: request,
		});
		expect(receipt).toMatchObject({ stored: true, utf8Bytes: request.length });
		expect(
			store.read({
				reference: receipt.reference as string,
				requesterAgentId: "agent-a",
				requesterConversationId: "room-a",
			}),
		).toBe(request);
		expect(() =>
			store.read({
				reference: receipt.reference as string,
				requesterAgentId: "agent-b",
				requesterConversationId: "room-a",
			}),
		).toThrow(expect.objectContaining({ code: "REJECTED_MODEL_INPUT_FORBIDDEN" }));
	});

	it("expires explicitly and never returns a prefix", () => {
		let now = 1_000;
		const store = new RejectedModelInputStore({ ttlMs: 10, now: () => now });
		const receipt = store.put({
			ownerAgentId: "agent",
			serializedRequest: "complete",
		});
		now = 1_010;
		expect(() =>
			store.read({
				reference: receipt.reference as string,
				requesterAgentId: "agent",
			}),
		).toThrow(expect.objectContaining({ code: "REJECTED_MODEL_INPUT_EXPIRED" }));
	});

	it("refuses an oversized request as one unit without evicting a live entry", () => {
		const store = new RejectedModelInputStore({
			maxEntries: 1,
			maxBytes: 16,
			maxEntryBytes: 16,
		});
		const first = store.put({
			ownerAgentId: "agent",
			serializedRequest: "first-complete",
		});
		const refused = store.put({
			ownerAgentId: "agent",
			serializedRequest: "second-complete",
		});
		expect(first.stored).toBe(true);
		expect(refused.stored).toBe(false);
		expect(refused).not.toHaveProperty("reference");
		expect(
			store.read({
				reference: first.reference as string,
				requesterAgentId: "agent",
			}),
		).toBe("first-complete");
	});
});
