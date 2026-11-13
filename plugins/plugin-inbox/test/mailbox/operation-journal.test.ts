/**
 * Durable reviewed Gmail operations against an in-memory compare-and-exchange
 * store and a synthetic provider. No account, network or mail is involved.
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/mailbox/digest.ts";
import {
  InboxOperation,
  type InboxOperationRecord,
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
  const calls = { prepare: 0, dispatch: 0, read: 0 };
  let observedPhase: string | null = null;
  const fixture = {
    calls,
    receipts,
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
        const receipt = receipts.get(requestId);
        if (!receipt) throw new Error("unknown receipt");
        return receipt;
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

  it("never dispatches again after a lost reply and resolves only from the receipt", async () => {
    const fixture = provider({ outcome: "lost" });
    const operation = journal(fixture);
    await operation.prepare(send(), { draftId: "draft-1" });
    await expect(
      operation.confirm({ draftId: "draft-1", proposal: send() }),
    ).rejects.toThrow("Failed to fetch");
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

  it.each(["dispatched", "outcome-unknown"] as const)(
    "keeps an observed %s receipt when a later read returns prepared",
    async (outcome) => {
      const fixture = provider({ outcome });
      const operation = journal(fixture);
      const email = { draftId: "draft-1", proposal: send() };
      const prepared = await operation.prepare(email.proposal, {
        draftId: email.draftId,
      });
      const observed = await operation.confirm(email);
      if (!prepared?.receipt || !observed?.receipt)
        throw new Error("The fixture did not produce both exact receipts");
      expect(observed.receipt.state).toBe(outcome);
      await expect(operation.clear()).rejects.toThrow("Outcome is unresolved");

      // The server reads from an older replica, then catches up. Neither a
      // restart nor an older receipt may permit the same request to send again.
      fixture.receipts.set(prepared.requestId, prepared.receipt);
      const reloaded = journal(fixture);
      expect(await reloaded.load()).toEqual(observed);
      expect(await reloaded.refresh()).toEqual(observed);
      await expect(reloaded.confirm(email)).rejects.toThrow(
        "A fresh exact review is required",
      );
      await expect(reloaded.clear()).rejects.toThrow("Outcome is unresolved");
      expect(fixture.calls.dispatch).toBe(1);

      const settled = {
        ...observed.receipt,
        state: "succeeded" as const,
        providerResult: { messageId: "sent-1" },
      };
      fixture.receipts.set(settled.requestId, settled);
      expect((await reloaded.refresh())?.receipt).toEqual(settled);
      expect(fixture.calls.dispatch).toBe(1);
    },
  );

  it("discards an attempted operation only while the provider reports it as prepared", async () => {
    const unsent = provider({ outcome: "prepared" });
    const operation = journal(unsent);
    await operation.prepare(send(), { draftId: "draft-1" });
    const record = await operation.confirm({
      draftId: "draft-1",
      proposal: send(),
    });
    expect(record?.phase).toBe("dispatching");
    await expect(operation.clear()).rejects.toThrow("Outcome is unresolved");
    expect(await operation.abandon()).toBeNull();
    expect(unsent.store.slots.size).toBe(0);
    expect(unsent.calls.dispatch).toBe(1);

    // The provider started this one, so the record stays with its receipt.
    const lost = provider({ outcome: "lost" });
    const uncertain = journal(lost);
    await uncertain.prepare(send(), { draftId: "draft-1" });
    await expect(
      uncertain.confirm({ draftId: "draft-1", proposal: send() }),
    ).rejects.toThrow("Failed to fetch");
    const kept = await uncertain.abandon();
    expect(kept?.phase).toBe("observed");
    expect(kept?.receipt?.state).toBe("succeeded");
    expect(lost.store.slots.size).toBe(1);
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
});

it("retains an attempted operation when its owner retires during the discard receipt read", async () => {
  const f = provider({ outcome: "prepared" });
  let active = true;
  const operation = journal(f, () => active);
  await operation.prepare(send(), { draftId: "draft-1" });
  await operation.confirm({ draftId: "draft-1", proposal: send() });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.client.gmailOperation;
  f.client.gmailOperation = async (grant, requestId) => {
    entered.resolve();
    await release.promise;
    return read(grant, requestId);
  };
  const abandoning = operation.abandon();
  const outcome = abandoning.catch((error: unknown) => error);
  await entered.promise;
  active = false;
  release.resolve();
  await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
  expect(f.store.slots.size).toBe(1);
  expect(f.calls.dispatch).toBe(1);
});

it("retains an attempted operation when its discard write conflicts", async () => {
  const f = provider({ outcome: "prepared" });
  const operation = journal(f);
  await operation.prepare(send(), { draftId: "draft-1" });
  await operation.confirm({ draftId: "draft-1", proposal: send() });
  f.store.compareExchange = async () => ({ status: "conflict" });
  await expect(operation.abandon()).rejects.toThrow("Inbox operation changed");
  expect(operation.snapshot()?.phase).toBe("dispatching");
  expect(f.store.slots.size).toBe(1);
  expect(f.calls.dispatch).toBe(1);
});
