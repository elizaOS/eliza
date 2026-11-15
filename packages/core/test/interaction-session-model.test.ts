/** Regression checks for properties of quint/InteractionSession.qnt that the code once broke. */
import { describe, expect, it } from "vitest";
import {
	createOpaqueMessageInteractionReference,
	encodeMessageInteractionCallback,
	InMemoryMessageInteractionSessionStore,
	type MessageInteractionSession,
	MessageInteractionSessionAuthority,
} from "../src/messaging/interaction-sessions";

const iso = (ms: number) => new Date(ms).toISOString();

function session(): MessageInteractionSession {
	return {
		sessionVersion: 1,
		reference: createOpaqueMessageInteractionReference(),
		purpose: "choice",
		blockKind: "choice",
		flow: "native",
		profileId: "test",
		bindings: {
			actorId: "actor",
			agentId: "agent",
			connector: { source: "test", accountId: "account" },
			audience: { kind: "task", id: "task-1" },
			roomId: "task-1",
			sourceMessageId: "message-1",
		},
		responseSchema: {
			fields: [
				{ name: "choice", type: "select", required: true, options: ["yes"] },
			],
			additionalFields: false,
		},
		presetResponse: null,
		authorization: {
			decisionId: "grant",
			policyRevision: "policy",
			state: "active",
			decidedAt: iso(1000),
			revokedAt: null,
		},
		effect: { kind: "choose" },
		createdAt: iso(1000),
		expiresAt: iso(10_000),
		consume: { state: "pending" },
		revision: 0,
	};
}

const claim = (value: MessageInteractionSession, now: number) => ({
	...value.bindings,
	reference: value.reference,
	replayKey: "response-1",
	response: { choice: "yes" },
	claimId: "claim-1",
	now,
	claimTtlMs: 500,
});

const commit = (value: MessageInteractionSession, now: number) => ({
	reference: value.reference,
	claimId: "claim-1",
	replayKey: "response-1",
	now,
});

describe("InteractionSession model properties", () => {
	it("refuses a commit after the claim lease expired (NoLateCommit)", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		const value = session();
		await store.create(value);
		await store.claimIfCurrent(claim(value, 1100));
		await expect(
			store.commitIfClaimed(commit(value, 1600)),
		).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_EXPIRED" });
		expect((await store.get(value.reference))?.consume.state).toBe("claimed");
	});

	it("refuses a commit after the session expired (NoLateCommit)", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		const value = session();
		await store.create(value);
		await store.claimIfCurrent(claim(value, 9900));
		await expect(
			store.commitIfClaimed(commit(value, 10_000)),
		).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_EXPIRED" });
	});

	it("keeps a committed outcome through deleteExpired until reconciled (AmbiguousRetained)", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		const value = session();
		await store.create(value);
		let now = 1100;
		let effects = 0;
		const consumed = new MessageInteractionSessionAuthority(store, {
			clock: () => now,
		}).consumeWithOutcome({
			callbackData: encodeMessageInteractionCallback(value.reference),
			bindings: value.bindings,
			replayKey: "response-1",
			response: { choice: "yes" },
			executor: {
				execute: async () => {
					effects += 1;
					// A retention sweep runs while the effect is in flight.
					now = 50_000;
					await store.deleteExpired(now);
					throw new Error("provider timed out");
				},
			},
		});
		await expect(consumed).rejects.toThrow("provider timed out");
		expect(effects).toBe(1);
		expect(
			(await store.listCommitted({ committedBefore: now, limit: 10 })).map(
				(found) => found.reference,
			),
		).toEqual([value.reference]);
		await store.reconcileCommitted({
			reference: value.reference,
			replayKey: "response-1",
			receipt: {
				receiptId: "receipt-1",
				idempotencyKey: "response-1",
				status: "completed",
				completedAt: iso(now),
				result: {},
			},
			now,
		});
		expect((await store.get(value.reference))?.consume.state).toBe("completed");
	});
});
