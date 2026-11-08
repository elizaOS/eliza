/**
 * Durable reviewed Gmail operations against an in-memory compare-and-exchange
 * store and a synthetic provider. No account, network or mail is involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/mailbox/digest.ts";
import { ManagedGmailProtocolError } from "../../src/mailbox/failures.ts";
import {
  INBOX_ACKNOWLEDGED_LIMIT,
  INBOX_DISPATCH_SETTLE_MS,
  InboxOperation,
  type InboxOperationRecord,
  inboxAcknowledgedKey,
  inboxOperationKey,
  reviewBinding,
} from "../../src/mailbox/operation-journal.ts";
import type { GmailInboxReceipt } from "../../src/mailbox/types.ts";

type Bag = Record<string, unknown>;

function memoryStore() {
  const slots = new Map<string, string>();
  return {
    slots,
    async read<T>(key: string): Promise<T | null> {
      const raw = slots.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async compareExchange(key: string, expected: unknown, value: unknown) {
      const actual = slots.has(key)
        ? JSON.parse(slots.get(key) as string)
        : null;
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        return { status: "conflict" };
      if (value === null) slots.delete(key);
      else slots.set(key, JSON.stringify(value));
      return { status: "saved" };
    },
  };
}

function provider(
  options: {
    outcome?: GmailInboxReceipt["state"] | "lost";
    tamper?: (review: Bag) => Bag;
  } = {},
) {
  const receipts = new Map<string, GmailInboxReceipt>();
  const calls = { prepare: 0, dispatch: 0, read: 0, cancel: 0, sends: 0 };
  let observedPhase: string | null = null;
  const fixture = {
    calls,
    receipts,
    /** Thrown by the next dispatches before Cloud claims the request. */
    dispatchError: null as unknown,
    readFails: false,
    /** An older Cloud without the cancel route. */
    cancelMissing: false,
    store: memoryStore(),
    get observedPhase() {
      return observedPhase;
    },
    client: {
      async gmailPrepareOperation(
        _grant: string,
        requestId: string,
        proposal: Bag,
      ) {
        calls.prepare++;
        let review: Bag = {
          ...proposal,
          from: "owner@example.invalid",
          attachments: [],
        };
        if (options.tamper) review = options.tamper(review);
        const receipt: GmailInboxReceipt = {
          requestId,
          kind: proposal.kind as GmailInboxReceipt["kind"],
          state: "prepared",
          reviewDigest: await sha256Hex(JSON.stringify(review)),
          providerResult: null,
          rejectionCode: null,
        };
        receipts.set(requestId, receipt);
        return { receipt, review };
      },
      async gmailDispatchOperation(
        grant: string,
        requestId: string,
        reviewDigest: string,
        proposal: Bag,
      ) {
        calls.dispatch++;
        const saved = await fixture.store.read<InboxOperationRecord>(
          await inboxOperationKey("owner", grant),
        );
        observedPhase = saved?.phase ?? null;
        if (fixture.dispatchError) throw fixture.dispatchError;
        // Like Cloud: only a prepared request is claimed; any other is returned as it is.
        const current = receipts.get(requestId);
        if (current && current.state !== "prepared") return current;
        calls.sends++;
        const outcome = options.outcome ?? "succeeded";
        const result: GmailInboxReceipt = {
          requestId,
          kind: proposal.kind as GmailInboxReceipt["kind"],
          state: outcome === "lost" ? "succeeded" : outcome,
          reviewDigest,
          providerResult:
            outcome === "succeeded" || outcome === "lost"
              ? { messageId: "sent-1" }
              : null,
          rejectionCode: outcome === "rejected" ? "policy" : null,
        };
        receipts.set(requestId, result);
        if (outcome === "lost") throw new TypeError("Failed to fetch");
        return result;
      },
      async gmailOperation(_grant: string, requestId: string) {
        calls.read++;
        if (fixture.readFails) throw new TypeError("Failed to fetch");
        const receipt = receipts.get(requestId);
        if (!receipt) throw new Error("unknown receipt");
        return receipt;
      },
      async gmailCancelOperation(_grant: string, requestId: string) {
        calls.cancel++;
        if (fixture.cancelMissing)
          throw new ManagedGmailProtocolError("http", 404);
        const receipt = receipts.get(requestId);
        if (!receipt) throw new Error("unknown receipt");
        if (receipt.state !== "prepared") return receipt;
        const cancelled: GmailInboxReceipt = {
          ...receipt,
          state: "rejected",
          rejectionCode: "cancelled",
        };
        receipts.set(requestId, cancelled);
        return cancelled;
      },
    },
  };
  return fixture;
}

const reviewAttachment = async (file: {
  name: string;
  mimeType: string;
  dataBase64: string;
}) => ({
  name: file.name,
  mimeType: file.mimeType,
  size: atob(file.dataBase64).length,
  sha256: await sha256Hex(atob(file.dataBase64)),
});

function journal(fixture: ReturnType<typeof provider>, active = () => true) {
  return new InboxOperation({
    owner: "owner",
    grantId: "grant",
    active,
    store: fixture.store,
    client: fixture.client,
    reviewAttachment,
  });
}

const send = (body = "Hello"): Bag => ({
  kind: "send",
  mode: "compose",
  to: ["friend@example.invalid"],
  subject: "Subject",
  bodyText: body,
});

describe("InboxOperation", () => {
  it("persists dispatching before the single dispatch and records the receipt", async () => {
    const fixture = provider();
    const operation = journal(fixture);
    const prepared = await operation.prepare(send(), { draftId: "draft-1" });
    expect(prepared?.phase).toBe("review");
    expect(prepared?.composer).toEqual({ draftId: "draft-1" });
    expect(prepared?.source).toEqual({ draftId: "draft-1" });
    const done = await operation.confirm({
      draftId: "draft-1",
      proposal: send(),
    });
    expect(fixture.observedPhase).toBe("dispatching");
    expect(done?.phase).toBe("observed");
    expect(done?.receipt?.state).toBe("succeeded");
    expect(fixture.calls.dispatch).toBe(1);
    await operation.clear();
    expect(operation.snapshot()).toBeNull();
  });

  it("resolves a lost dispatch reply from one receipt read, never a second dispatch", async () => {
    const fixture = provider({ outcome: "lost" });
    const operation = journal(fixture);
    await operation.prepare(send(), { draftId: "draft-1" });
    const record = await operation.confirm({
      draftId: "draft-1",
      proposal: send(),
    });
    expect(record?.receipt?.state).toBe("succeeded");
    expect(fixture.calls).toMatchObject({ dispatch: 1, read: 1 });
  });

  it("never dispatches again after a lost reply and resolves only from the receipt", async () => {
    const fixture = provider({ outcome: "lost" });
    fixture.readFails = true;
    const operation = journal(fixture);
    await operation.prepare(send(), { draftId: "draft-1" });
    await expect(
      operation.confirm({ draftId: "draft-1", proposal: send() }),
    ).rejects.toThrow("Failed to fetch");
    fixture.readFails = false;
    expect(operation.snapshot()?.phase).toBe("dispatching");
    await expect(
      operation.confirm({ draftId: "draft-1", proposal: send() }),
    ).rejects.toThrow("A fresh exact review is required");
    await expect(operation.clear()).rejects.toThrow("Outcome is unresolved");
    // A reload keeps the uncertain state; recovery reads the receipt, never dispatches.
    const reloaded = journal(fixture);
    expect((await reloaded.load())?.phase).toBe("dispatching");
    const settled = await reloaded.refresh();
    expect(settled?.receipt?.state).toBe("succeeded");
    expect(fixture.calls.dispatch).toBe(1);
  });

  it("keeps an unknown outcome uncertain and refuses to clear it", async () => {
    const fixture = provider({ outcome: "outcome-unknown" });
    const operation = journal(fixture);
    await operation.prepare(send(), { draftId: "draft-1" });
    const record = await operation.confirm({
      draftId: "draft-1",
      proposal: send(),
    });
    expect(record?.receipt?.state).toBe("outcome-unknown");
    await expect(operation.clear()).rejects.toThrow("Outcome is unresolved");
    expect(fixture.calls.dispatch).toBe(1);
  });

  it("refuses a server review that changed recipients or attachments", async () => {
    const changed = provider({
      tamper: (review) => ({ ...review, to: ["other@example.invalid"] }),
    });
    await expect(journal(changed).prepare(send())).rejects.toThrow(
      "Server changed the reviewed recipients",
    );
    const attachments = provider({
      tamper: (review) => ({ ...review, attachments: [] }),
    });
    await expect(
      journal(attachments).prepare({
        ...send(),
        attachments: [
          { name: "a.txt", mimeType: "text/plain", dataBase64: btoa("hi") },
        ],
      }),
    ).rejects.toThrow("Server changed the reviewed attachments");
    expect(changed.calls.dispatch + attachments.calls.dispatch).toBe(0);
  });

  it("binds a composer review to the exact email and content", async () => {
    const fixture = provider();
    const operation = journal(fixture);
    const record = (await operation.prepare(send(), {
      draftId: "draft-1",
    })) as InboxOperationRecord;
    expect(
      reviewBinding(record, { draftId: "draft-1", proposal: send() }),
    ).toBe("bound");
    expect(
      reviewBinding(record, { draftId: "draft-1", proposal: send("Edited") }),
    ).toBe("edited");
    expect(
      reviewBinding(record, { draftId: "draft-2", proposal: send() }),
    ).toBe("other");
    expect(reviewBinding(record, null)).toBe("absent");
    await expect(
      operation.confirm({ draftId: "draft-1", proposal: send("Edited") }),
    ).rejects.toThrow("edited after this review");
    await expect(operation.confirm(null)).rejects.toThrow(
      "not open in the composer",
    );
    expect(fixture.calls.dispatch).toBe(0);
  });

  it("discards only an undispatched review for a withdrawn grant", async () => {
    const fixture = provider();
    await journal(fixture).prepare(send());
    expect(
      await InboxOperation.discardUnsent(fixture.store, "owner", "grant"),
    ).toBe(true);
    expect(fixture.store.slots.size).toBe(0);
    const dispatched = provider({ outcome: "outcome-unknown" });
    const operation = journal(dispatched);
    await operation.prepare(send(), { draftId: "d" });
    await operation.confirm({ draftId: "d", proposal: send() });
    expect(
      await InboxOperation.discardUnsent(dispatched.store, "owner", "grant"),
    ).toBe(false);
    expect(dispatched.store.slots.size).toBe(1);
  });

  it("refuses a saved record of another owner and stops after an account change", async () => {
    const fixture = provider();
    await journal(fixture).prepare(send());
    const [key, raw] = [...fixture.store.slots][0] as [string, string];
    fixture.store.slots.set(key, raw.replace('"owner":"owner"', '"owner":"x"'));
    await expect(journal(fixture).load()).rejects.toThrow(
      "Invalid saved Inbox operation",
    );
    let active = true;
    const stale = journal(provider(), () => active);
    active = false;
    await expect(stale.prepare(send())).rejects.toThrow(
      "Inbox account changed",
    );
  });

  it("keeps local copies after a reload until the provider reports the same send again", async () => {
    const fixture = provider();
    const operation = journal(fixture);
    await operation.prepare(send(), {
      draftId: "draft-1",
      savedRevision: "r1",
    });
    await operation.confirm({ draftId: "draft-1", proposal: send() });
    const agreeing = journal(fixture);
    expect((await agreeing.load())?.source).toEqual({
      draftId: "draft-1",
      savedRevision: "r1",
    });
    fixture.receipts.clear();
    const disagreeing = journal(fixture);
    const loaded = await disagreeing.load();
    expect(loaded?.receipt?.state).toBe("succeeded");
    expect(loaded?.source).toBeUndefined();
  });

  it("returns Cloud's own refusal of an unclaimed dispatch to review", async () => {
    const fixture = provider();
    const operation = journal(fixture);
    const prepared = await operation.prepare(send(), { draftId: "d" });
    fixture.dispatchError = new ManagedGmailProtocolError("http", 409, {
      error: "Review changed",
    });
    await expect(
      operation.confirm({ draftId: "d", proposal: send() }),
    ).rejects.toThrow("409");
    const back = operation.snapshot();
    expect(back?.phase).toBe("review");
    expect(back?.requestId).toBe(prepared?.requestId);
    expect(back?.dispatchStartedAt).toBeUndefined();
    // A later Confirm dispatches the same prepared request.
    fixture.dispatchError = null;
    const done = await operation.confirm({ draftId: "d", proposal: send() });
    expect(done?.receipt?.state).toBe("succeeded");
    expect(done?.requestId).toBe(prepared?.requestId);
    expect(fixture.calls.sends).toBe(1);
  });

  it("keeps a 5xx, a gateway 4xx or a timeout dispatching after reading the receipt", async () => {
    for (const error of [
      new ManagedGmailProtocolError("http", 503, { error: "Unavailable" }),
      new ManagedGmailProtocolError("http", 403),
      new ManagedGmailProtocolError("http", 413, "<html>Too large</html>"),
      new Error("Connection timed out"),
    ]) {
      const fixture = provider();
      const operation = journal(fixture);
      await operation.prepare(send(), { draftId: "d" });
      fixture.dispatchError = error;
      const failure = await operation
        .confirm({ draftId: "d", proposal: send() })
        .catch((thrown: Error) => thrown);
      expect(operation.snapshot()?.phase).toBe("dispatching");
      expect(fixture.calls).toMatchObject({ dispatch: 1, read: 1, sends: 0 });
      // A timeout is an unknown outcome, never "offline".
      if (error.message.includes("timed out"))
        expect((failure as Error).message).toMatch(/did not answer in time/);
      else expect(failure).toBe(error);
    }
  });

  describe("an unclaimed dispatch", () => {
    afterEach(() => vi.useRealTimers());

    async function stuck() {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000_000);
      const fixture = provider();
      const operation = journal(fixture);
      await operation.prepare(send(), { draftId: "d" });
      fixture.dispatchError = new Error("Connection timed out");
      await operation
        .confirm({ draftId: "d", proposal: send() })
        .catch(() => {});
      expect(operation.snapshot()?.phase).toBe("dispatching");
      return { fixture, operation };
    }

    it("is discarded through Cloud's cancel, which frees the slot", async () => {
      const { fixture, operation } = await stuck();
      await expect(operation.discard()).rejects.toThrow(
        "has not received can be discarded",
      );
      expect(fixture.calls.cancel).toBe(0);
      vi.setSystemTime(1_000_000 + INBOX_DISPATCH_SETTLE_MS);
      const requestId = operation.snapshot()?.requestId as string;
      expect(await operation.discard()).toBeNull();
      expect(fixture.store.slots.size).toBe(0);
      // A delayed dispatch of the cancelled request is refused by Cloud.
      fixture.dispatchError = null;
      const late = await fixture.client.gmailDispatchOperation(
        "grant",
        requestId,
        "digest",
        send(),
      );
      expect(late).toMatchObject({
        state: "rejected",
        rejectionCode: "cancelled",
      });
      expect(fixture.calls.sends).toBe(0);
      // The slot is free for a new review.
      expect((await operation.prepare(send(), { draftId: "d" }))?.phase).toBe(
        "review",
      );
    });

    it("keeps the request when Cloud claimed it before the cancel", async () => {
      const { fixture, operation } = await stuck();
      vi.setSystemTime(1_000_000 + INBOX_DISPATCH_SETTLE_MS);
      // The delayed dispatch wins the race; the cancel then finds it claimed.
      fixture.dispatchError = null;
      const requestId = operation.snapshot()?.requestId as string;
      await fixture.client.gmailDispatchOperation(
        "grant",
        requestId,
        operation.snapshot()?.receipt?.reviewDigest as string,
        send(),
      );
      const kept = await operation.discard();
      expect(kept?.receipt?.state).toBe("succeeded");
      expect(fixture.store.slots.size).toBe(1);
      expect(fixture.calls.sends).toBe(1);
    });

    it("keeps today's behaviour with an older Cloud that has no cancel", async () => {
      const { fixture, operation } = await stuck();
      vi.setSystemTime(1_000_000 + INBOX_DISPATCH_SETTLE_MS);
      fixture.cancelMissing = true;
      await expect(operation.discard()).rejects.toThrow(
        "Outcome is unresolved",
      );
      expect(operation.snapshot()?.phase).toBe("dispatching");
    });
  });

  it("frees the slot after an acknowledged unknown outcome and never reuses its request id", async () => {
    const fixture = provider({ outcome: "outcome-unknown" });
    const operation = journal(fixture);
    const first = await operation.prepare(send(), { draftId: "d" });
    await operation.confirm({ draftId: "d", proposal: send() });
    await operation.acknowledge();
    expect(operation.snapshot()).toBeNull();
    const history = await fixture.store.read<{ requestIds: string[] }>(
      await inboxAcknowledgedKey("owner", "grant"),
    );
    expect(history?.requestIds).toEqual([first?.requestId]);
    const fresh = "00000000-0000-4000-8000-0000000000aa";
    const mint = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(
        first?.requestId as `${string}-${string}-${string}-${string}-${string}`,
      )
      .mockReturnValueOnce(fresh);
    try {
      expect(
        (await operation.prepare(send(), { draftId: "d" }))?.requestId,
      ).toBe(fresh);
    } finally {
      mint.mockRestore();
    }
    expect(fixture.calls.sends).toBe(1);
  });

  it("refuses an acknowledgement while Cloud can still settle the request", async () => {
    const fixture = provider({ outcome: "dispatched" });
    const operation = journal(fixture);
    await operation.prepare(send(), { draftId: "d" });
    await operation.confirm({ draftId: "d", proposal: send() });
    await expect(operation.acknowledge()).rejects.toThrow("still settling");
    expect(operation.snapshot()?.receipt?.state).toBe("dispatched");
    expect(fixture.store.slots.size).toBe(1);
  });

  it("keeps the newest acknowledged request ids, dropping the oldest", async () => {
    const fixture = provider({ outcome: "outcome-unknown" });
    const operation = journal(fixture);
    const ids: string[] = [];
    for (let index = 0; index <= INBOX_ACKNOWLEDGED_LIMIT; index++) {
      ids.push(
        (await operation.prepare(send(), { draftId: "d" }))
          ?.requestId as string,
      );
      await operation.confirm({ draftId: "d", proposal: send() });
      await operation.acknowledge();
    }
    const history = await fixture.store.read<{ requestIds: string[] }>(
      await inboxAcknowledgedKey("owner", "grant"),
    );
    expect(history?.requestIds).toEqual(ids.slice(1));
  });
});
