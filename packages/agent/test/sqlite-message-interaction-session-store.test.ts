import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createOpaqueMessageInteractionReference,
  encodeMessageInteractionCallback,
  type MessageInteractionSession,
  MessageInteractionSessionAuthority,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SqliteMessageInteractionSessionStore } from "../src/services/sqlite-message-interaction-session-store.ts";

const now = 1000;
function fixture(): MessageInteractionSession {
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
      sourceMessageId: "task-1:epoch-0:review-1",
    },
    responseSchema: {
      fields: [
        {
          name: "choice",
          type: "select",
          required: true,
          options: ["yes", "no"],
        },
      ],
      additionalFields: false,
    },
    presetResponse: null,
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date(now).toISOString(),
      revokedAt: null,
    },
    effect: { kind: "choose-existing-method" },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(10000).toISOString(),
    consume: { state: "pending" },
    revision: 0,
  };
}
const claim = (session: MessageInteractionSession) => ({
  ...session.bindings,
  reference: session.reference,
  replayKey: "response-1",
  response: { choice: "yes" },
  claimId: "claim-1",
  now: 1100,
  claimTtlMs: 500,
});
const receipt = () => ({
  receiptId: "receipt-1",
  idempotencyKey: "response-1",
  status: "completed" as const,
  completedAt: new Date(1400).toISOString(),
  result: { selected: true },
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "eliza-choice-sqlite-"));
  const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(join(root, "journal.sqlite"));
    connections.add(db);
    db.exec("PRAGMA synchronous = FULL");
    return { db, store: new SqliteMessageInteractionSessionStore(db) };
  };
  return {
    open,
    closeConnection: (db: DatabaseSync) => {
      db.close();
      connections.delete(db);
    },
    close: () => {
      for (const db of connections) db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
describe("SQLite message interaction sessions", () => {
  it("executes one authority callback across two connections and replays the retained receipt", async () => {
    const test = setup();
    try {
      const a = test.open(),
        b = test.open(),
        session = fixture();
      await a.store.create(session);
      let effects = 0,
        release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const args = {
        callbackData: encodeMessageInteractionCallback(session.reference),
        bindings: session.bindings,
        replayKey: "response-1",
        response: { choice: "yes" },
        executor: {
          execute: async () => {
            effects++;
            await waiting;
            return receipt();
          },
        },
      };
      const first = new MessageInteractionSessionAuthority(a.store, {
        clock: () => 1500,
      }).consumeWithOutcome(args);
      // Wait until the first callback is durably committed and has entered its effect.
      for (let i = 0; i < 20 && effects === 0; i++) await Promise.resolve();
      expect(effects).toBe(1);
      expect(
        (
          await new MessageInteractionSessionAuthority(b.store, {
            clock: () => 1500,
          }).consumeWithOutcome(args)
        ).status,
      ).toBe("in_progress");
      release();
      expect((await first).status).toBe("completed");
      expect(
        (
          await new MessageInteractionSessionAuthority(b.store, {
            clock: () => 1500,
          }).consumeWithOutcome(args)
        ).status,
      ).toBe("replay");
      expect(effects).toBe(1);
      await expect(
        new MessageInteractionSessionAuthority(b.store, {
          clock: () => 1500,
        }).consumeWithOutcome({ ...args, response: { choice: "no" } }),
      ).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_ALREADY_CONSUMED" });
      await expect(b.store.create(session)).rejects.toMatchObject({
        code: "MESSAGE_INTERACTION_ALREADY_EXISTS",
      });
    } finally {
      test.close();
    }
  });
  it("retains ambiguous commits through reopen and expiry until read-only reconciliation", async () => {
    const test = setup();
    try {
      const a = test.open(),
        session = fixture();
      await a.store.create(session);
      await a.store.claimIfCurrent(claim(session));
      await a.store.commitIfClaimed({
        reference: session.reference,
        claimId: "claim-1",
        replayKey: "response-1",
        now: 1200,
      });
      test.closeConnection(a.db);
      const b = test.open();
      expect(await b.store.deleteExpired(50000)).toBe(0);
      expect(
        (await b.store.listCommitted({ committedBefore: 50000, limit: 1 })).map(
          (value) => value.reference,
        ),
      ).toEqual([session.reference]);
      expect(
        (
          await b.store.claimIfCurrent({
            ...claim(session),
            now: 50000,
            claimId: "late",
          })
        ).status,
      ).toBe("in_progress");
      await b.store.reconcileCommitted({
        reference: session.reference,
        replayKey: "response-1",
        receipt: receipt(),
        now: 50000,
      });
      expect((await b.store.get(session.reference))?.consume.state).toBe(
        "completed",
      );
      expect(await b.store.deleteExpired(50001)).toBe(1);
    } finally {
      test.close();
    }
  });
  it("rejects foreign or stale context and expired commitments without changing the claim", async () => {
    const test = setup();
    try {
      const { store } = test.open(),
        session = fixture();
      await store.create(session);
      for (const foreign of [
        { actorId: "other" },
        { sourceMessageId: "task-1:epoch-1:review-1" },
        { connector: { source: "test", accountId: "other" } },
      ])
        await expect(
          store.claimIfCurrent({ ...claim(session), ...foreign }),
        ).rejects.toMatchObject({
          code: "MESSAGE_INTERACTION_BINDING_MISMATCH",
        });
      await store.claimIfCurrent(claim(session));
      await expect(
        store.commitIfClaimed({
          reference: session.reference,
          claimId: "claim-1",
          replayKey: "response-1",
          now: 1600,
        }),
      ).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_EXPIRED" });
      expect((await store.get(session.reference))?.consume.state).toBe(
        "claimed",
      );
      await store.revokeAuthorization({
        reference: session.reference,
        decisionId: "grant",
        now: 1700,
      });
      await expect(
        store.claimIfCurrent({ ...claim(session), now: 1800 }),
      ).rejects.toMatchObject({
        code: "MESSAGE_INTERACTION_AUTHORIZATION_REVOKED",
      });
    } finally {
      test.close();
    }
  });
  it("rolls back a failed durable write and refuses corrupt stored records", async () => {
    const test = setup();
    try {
      const { db, store } = test.open(),
        session = fixture();
      await store.create(session);
      db.exec(
        "CREATE TRIGGER fault BEFORE UPDATE ON message_interaction_sessions_v1 BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;",
      );
      await expect(store.claimIfCurrent(claim(session))).rejects.toThrow(
        /injected storage failure/,
      );
      expect((await store.get(session.reference))?.consume.state).toBe(
        "pending",
      );
      db.exec("DROP TRIGGER fault");
      db.prepare(
        "UPDATE message_interaction_sessions_v1 SET document = ? WHERE reference = ?",
      ).run('{"reference":"foreign"}', session.reference);
      await expect(store.get(session.reference)).rejects.toMatchObject({
        code: "MESSAGE_INTERACTION_STORAGE_CORRUPT",
      });
    } finally {
      test.close();
    }
  });
});
