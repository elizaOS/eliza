/**
 * Read-state guard: one change per message in flight, and an automatic
 * mark-read whose outcome was not confirmed is never sent again. Synthetic
 * inbox-v1 operation routes only; no provider or network.
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/mailbox/digest.ts";
import {
  type GmailReadStateClient,
  MailReadStateGuard,
  mailReadStateMessage,
} from "../../src/mailbox/read-state.ts";
import type { GmailInboxReceipt } from "../../src/mailbox/types.ts";

type Answer = "succeeded" | "outcome-unknown" | "throw" | "hold";

/** One synthetic operation route. Each dispatch takes the next answer. */
function routes(answers: Answer[]) {
  const dispatched: string[] = [];
  let release: (() => void) | undefined;
  const client: GmailReadStateClient = {
    async gmailPrepareOperation(_grant, requestId, proposal) {
      const review = { ...proposal, from: "owner@example.invalid" };
      return {
        review,
        receipt: {
          requestId,
          kind: proposal.kind as GmailInboxReceipt["kind"],
          state: "prepared",
          reviewDigest: await sha256Hex(JSON.stringify(review)),
          providerResult: null,
          rejectionCode: null,
        },
      };
    },
    async gmailDispatchOperation(_grant, requestId, reviewDigest, proposal) {
      dispatched.push(`${proposal.kind}:${proposal.messageId}`);
      const answer = answers.shift() ?? "succeeded";
      if (answer === "throw") throw new Error("Connection lost");
      if (answer === "hold")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const unread = proposal.kind === "mark-unread";
      return {
        requestId,
        kind: proposal.kind as GmailInboxReceipt["kind"],
        state: answer === "outcome-unknown" ? "outcome-unknown" : "succeeded",
        reviewDigest,
        providerResult:
          answer === "outcome-unknown"
            ? null
            : { messageId: proposal.messageId, unread, historyId: "h2" },
        rejectionCode: null,
      };
    },
  };
  return { client, dispatched, release: () => release?.() };
}

const read = (messageId = "m1", unread = false) => ({
  messageId,
  expectedHistoryId: "h1",
  unread,
});

describe("MailReadStateGuard", () => {
  it("never resends an automatic mark-read whose outcome was not confirmed", async () => {
    const r = routes(["outcome-unknown"]);
    const guard = new MailReadStateGuard();
    expect(await guard.set(r.client, "grant", read(), false)).toEqual({
      status: "unconfirmed",
    });
    expect(await guard.set(r.client, "grant", read(), false)).toEqual({
      status: "skipped",
    });
    expect(r.dispatched).toEqual(["mark-read:m1"]);
    // The owner's explicit change may try again, and a confirmed result clears the mark.
    expect(await guard.set(r.client, "grant", read(), true)).toEqual({
      status: "changed",
      unread: false,
      historyId: "h2",
    });
    expect(await guard.set(r.client, "grant", read(), false)).toMatchObject({
      status: "changed",
    });
    expect(r.dispatched).toEqual([
      "mark-read:m1",
      "mark-read:m1",
      "mark-read:m1",
    ]);
  });

  it("treats a failed request as possibly applied", async () => {
    const r = routes(["throw"]);
    const guard = new MailReadStateGuard();
    const failed = await guard.set(r.client, "grant", read(), false);
    expect(failed.status).toBe("failed");
    expect(await guard.set(r.client, "grant", read(), false)).toEqual({
      status: "skipped",
    });
    expect(r.dispatched).toEqual(["mark-read:m1"]);
  });

  it("keeps one change per message in flight, separately per account and message", async () => {
    const r = routes(["hold"]);
    const guard = new MailReadStateGuard();
    const first = guard.set(r.client, "grant", read(), true);
    // Wait until the first change is held at dispatch.
    while (r.dispatched.length < 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await guard.set(r.client, "grant", read("m1", true), true)).toEqual({
      status: "busy",
    });
    expect(
      (await guard.set(r.client, "other-grant", read(), true)).status,
    ).toBe("changed");
    expect((await guard.set(r.client, "grant", read("m2"), true)).status).toBe(
      "changed",
    );
    r.release();
    expect((await first).status).toBe("changed");
    expect(r.dispatched).toEqual([
      "mark-read:m1",
      "mark-read:m1",
      "mark-read:m2",
    ]);
  });

  it("forgets unconfirmed messages when cleared for a new account or session", async () => {
    const r = routes(["outcome-unknown", "succeeded"]);
    const guard = new MailReadStateGuard();
    await guard.set(r.client, "grant", read(), false);
    guard.clear();
    expect((await guard.set(r.client, "grant", read(), false)).status).toBe(
      "changed",
    );
  });

  it("tells the owner only about explicit outcomes", () => {
    const failure = (error: unknown) => `Failed: ${(error as Error).message}`;
    expect(mailReadStateMessage({ status: "busy" }, false, failure)).toBe(
      "A read-state change for this message is still in progress.",
    );
    expect(
      mailReadStateMessage({ status: "skipped" }, false, failure),
    ).toBeNull();
    expect(mailReadStateMessage({ status: "unconfirmed" }, true, failure)).toBe(
      "Read state was not confirmed. Refresh to check it before trying again.",
    );
    expect(
      mailReadStateMessage(
        { status: "failed", error: new Error("offline") },
        true,
        failure,
      ),
    ).toBe("Failed: offline");
    expect(
      mailReadStateMessage(
        { status: "changed", unread: true, historyId: null },
        true,
        failure,
      ),
    ).toBe("Marked unread in Gmail");
    expect(
      mailReadStateMessage(
        { status: "changed", unread: false, historyId: null },
        false,
        failure,
      ),
    ).toBe("Marked read in Gmail");
  });
});
