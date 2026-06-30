/**
 * Bug A: cross-path delivery idempotency guard.
 *
 * Proves that one logical reply fanning out through two delivery sinks results
 * in exactly ONE delivery: the first call reserves + (on success) commits the
 * delivery, and a second identical (roomId + text) call within the window is a
 * duplicate. A FAILED delivery (release, no commit) must NOT suppress a retry.
 */

import { describe, expect, it } from "vitest";

import {
  beginDelivery,
  createDeliveryDedupeState,
  deliveryIdentityFromContent,
} from "./delivery-dedupe.ts";

const ROOM = "room-1";

/** Convenience: begin + (when delivering) commit immediately, returning true
 * when the caller should treat this as a duplicate to SUPPRESS. */
function deliverAndCommit(
  state: Parameters<typeof beginDelivery>[0],
  roomId: string | undefined,
  text: string | undefined,
  opts?: { now?: number; windowMs?: number },
): boolean {
  const r = beginDelivery(state, roomId, text, opts);
  if (r.kind === "duplicate") return true;
  r.reservation.commit();
  return false;
}

describe("beginDelivery", () => {
  it("one logical reply via two sinks → one delivery (second suppressed)", () => {
    const state = createDeliveryDedupeState();
    const text = "Here is your answer.";

    // First sink (e.g. client_chat send handler) delivers + commits.
    expect(deliverAndCommit(state, ROOM, text)).toBe(false);
    // Second sink (e.g. autonomy relay) for the SAME reply → duplicate.
    expect(deliverAndCommit(state, ROOM, text)).toBe(true);
  });

  it("a FAILED delivery (release, no commit) does NOT suppress a retry", () => {
    const state = createDeliveryDedupeState();
    const text = "retry me";

    // First attempt reserves, then FAILS (e.g. createMemory threw) → release.
    const first = beginDelivery(state, ROOM, text);
    expect(first.kind).toBe("deliver");
    if (first.kind === "deliver") first.reservation.release();

    // A fallback/retry of the same reply must be allowed (not a phantom dupe).
    expect(deliverAndCommit(state, ROOM, text)).toBe(false);
  });

  it("an in-flight (uncommitted, unreleased) reservation blocks a concurrent dup", () => {
    const state = createDeliveryDedupeState();
    const text = "in flight";

    const first = beginDelivery(state, ROOM, text);
    expect(first.kind).toBe("deliver");
    // While the first is still in flight (no commit/release yet), a concurrent
    // identical delivery is treated as a duplicate.
    expect(beginDelivery(state, ROOM, text).kind).toBe("duplicate");
  });

  it("collapses a rapid burst of committed copies to a single delivery", () => {
    const state = createDeliveryDedupeState();
    const text = "duplicated reply";
    const now = 1_000_000;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(deliverAndCommit(state, ROOM, text, { now: now + i * 100 }));
    }
    expect(results).toEqual([false, true, true, true, true]);
  });

  it("normalizes whitespace/case so trivially-different copies still dedupe", () => {
    const state = createDeliveryDedupeState();
    expect(deliverAndCommit(state, ROOM, "Hello   World")).toBe(false);
    expect(deliverAndCommit(state, ROOM, "hello world")).toBe(true);
  });

  it("does NOT dedupe across different rooms", () => {
    const state = createDeliveryDedupeState();
    const text = "same text different room";
    expect(deliverAndCommit(state, "room-a", text)).toBe(false);
    expect(deliverAndCommit(state, "room-b", text)).toBe(false);
  });

  it("allows the same text again AFTER the window expires", () => {
    const state = createDeliveryDedupeState();
    const text = "ok";
    const t0 = 5_000_000;
    expect(deliverAndCommit(state, ROOM, text, { now: t0 })).toBe(false);
    // 5s later (> 4s window): a genuine repeat, not a fan-out dupe → allowed.
    expect(deliverAndCommit(state, ROOM, text, { now: t0 + 5000 })).toBe(false);
  });

  it("never dedupes empty / whitespace-only text", () => {
    const state = createDeliveryDedupeState();
    expect(deliverAndCommit(state, ROOM, "")).toBe(false);
    expect(deliverAndCommit(state, ROOM, "   ")).toBe(false);
    expect(deliverAndCommit(state, ROOM, "   ")).toBe(false);
    expect(deliverAndCommit(state, ROOM, undefined)).toBe(false);
  });

  it("is a no-op (never suppresses) when state or roomId is missing", () => {
    const state = createDeliveryDedupeState();
    expect(deliverAndCommit(undefined, ROOM, "x")).toBe(false);
    expect(deliverAndCommit(state, undefined, "x")).toBe(false);
  });

  it("double commit / commit-after-release is safe (idempotent)", () => {
    const state = createDeliveryDedupeState();
    const r = beginDelivery(state, ROOM, "once");
    expect(r.kind).toBe("deliver");
    if (r.kind === "deliver") {
      r.reservation.commit();
      // A stray second commit or a release after commit must not throw or
      // resurrect/clear the anchor.
      r.reservation.commit();
      r.reservation.release();
    }
    // Still deduped (anchor intact).
    expect(deliverAndCommit(state, ROOM, "once")).toBe(true);
  });

  it("does NOT collapse two sends that share text but differ in attachments (identity)", () => {
    const state = createDeliveryDedupeState();
    const text = "Done";
    const idA = deliveryIdentityFromContent({
      attachments: [{ url: "https://x/a.png" }],
    });
    const idB = deliveryIdentityFromContent({
      attachments: [{ url: "https://x/b.png" }],
    });
    expect(idA).not.toBe(idB);

    const a = beginDelivery(state, ROOM, text, { identity: idA });
    expect(a.kind).toBe("deliver");
    if (a.kind === "deliver") a.reservation.commit();
    // Different attachment → different identity → NOT a duplicate.
    const b = beginDelivery(state, ROOM, text, { identity: idB });
    expect(b.kind).toBe("deliver");
    if (b.kind === "deliver") b.reservation.commit();
    // Same text + same attachment within window → IS a duplicate.
    expect(beginDelivery(state, ROOM, text, { identity: idA }).kind).toBe(
      "duplicate",
    );
  });

  it("deliveryIdentityFromContent: empty for plain text (incl. action-only), stable for same attachments", () => {
    expect(deliveryIdentityFromContent(undefined)).toBe("");
    expect(deliveryIdentityFromContent({ text: "hi" } as never)).toBe("");
    // CRITICAL cross-path invariant: a plain REPLY (client_chat) and a bare
    // text relay (autonomy, no action) must yield the SAME identity so the
    // duplicate is suppressed. Action must NOT contribute to identity.
    expect(deliveryIdentityFromContent({ text: "hi", action: "REPLY" })).toBe(
      "",
    );
    expect(
      deliveryIdentityFromContent({ text: "hi", actions: ["REPLY"] }),
    ).toBe("");
    // Same attachments -> same identity; only attachments discriminate.
    const c = { attachments: [{ url: "u1" }], action: "REPLY" };
    expect(deliveryIdentityFromContent(c)).toBe(
      deliveryIdentityFromContent({ attachments: [{ url: "u1" }] }),
    );
  });

  it("cross-path: a REPLY (client_chat) and a bare-text relay (autonomy) dedupe", () => {
    const state = createDeliveryDedupeState();
    const text = "Here is your answer.";
    // client_chat handler: normal reply content with actions:[REPLY].
    const idReply = deliveryIdentityFromContent({
      text,
      actions: ["REPLY"],
    });
    // autonomy relay: bare { text }, no identity supplied.
    expect(idReply).toBe("");
    const a = beginDelivery(state, ROOM, text, { identity: idReply });
    expect(a.kind).toBe("deliver");
    if (a.kind === "deliver") a.reservation.commit();
    // Autonomy relay (no identity) of the same reply -> suppressed.
    expect(beginDelivery(state, ROOM, text).kind).toBe("duplicate");
  });

  it("bounds the tracked key set", () => {
    const state = createDeliveryDedupeState();
    const now = 9_000_000;
    for (let i = 0; i < 1000; i += 1) {
      deliverAndCommit(state, `room-${i}`, "x", { now });
    }
    expect(state.recentDeliveries.size).toBeLessThanOrEqual(512);
  });
});
