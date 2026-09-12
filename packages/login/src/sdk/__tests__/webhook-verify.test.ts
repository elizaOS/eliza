import { describe, expect, test } from "bun:test";

import { signWebhookPayload, verifyWebhookSignature } from "../webhook-verify";

const SECRET = "whsec_test_secret_abc123";
const BODY = JSON.stringify({
  event: "tx.signed",
  txId: "0xfeed",
  agentId: "agent-1",
});

describe("verifyWebhookSignature", () => {
  test("accepts a correctly-signed body only with legacy opt-in", async () => {
    const sig = await signWebhookPayload(BODY, SECRET);
    const result = await verifyWebhookSignature(BODY, sig, SECRET, null, {
      allowLegacyBodySignature: true,
    });
    expect(result.valid).toBe(true);
  });

  test("accepts a legacy `${ts}.${body}` form ONLY with explicit opt-in", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload(`${ts}.${BODY}`, SECRET);
    const result = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      allowLegacyTimestampSignature: true,
    });
    expect(result.valid).toBe(true);
    expect(result.scheme).toBe("legacy-timestamp");
  });

  test("rejects a legacy `${ts}.${body}` signature by default (downgrade guard)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload(`${ts}.${BODY}`, SECRET);
    const result = await verifyWebhookSignature(BODY, sig, SECRET, ts);
    expect(result.valid).toBe(false);
    // No legacy candidate is even considered now, so verification refuses outright.
    expect(result.reason).toBe("bad-timestamp");
  });

  test("rejects legacy body signatures when a fresh timestamp is supplied", async () => {
    const sig = await signWebhookPayload(BODY, SECRET);
    const ts = Math.floor(Date.now() / 1000);
    const result = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      nowSec: ts,
      toleranceSec: 300,
      allowLegacyTimestampSignature: true,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad-signature");
  });

  test("rejects when signature is missing", async () => {
    const r = await verifyWebhookSignature(BODY, null, SECRET);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("missing-signature");
  });

  test("rejects when signature is wrong length / different secret", async () => {
    const bad = await signWebhookPayload(BODY, "another-secret");
    const r = await verifyWebhookSignature(BODY, bad, SECRET, null, {
      allowLegacyBodySignature: true,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  test("rejects when body has been tampered", async () => {
    const sig = await signWebhookPayload(BODY, SECRET);
    const tampered = BODY.replace("0xfeed", "0xdead");
    const r = await verifyWebhookSignature(tampered, sig, SECRET, null, {
      allowLegacyBodySignature: true,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  test("rejects a stale timestamp beyond tolerance", async () => {
    const ts = 1_000_000_000;
    const sig = await signWebhookPayload(`${ts}.${BODY}`, SECRET);
    const r = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      nowSec: ts + 1000,
      toleranceSec: 300,
      allowLegacyTimestampSignature: true,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stale-timestamp");
  });

  test("accepts an old timestamp when tolerance is Infinity", async () => {
    const ts = 1_000_000_000;
    const sig = await signWebhookPayload(`${ts}.${BODY}`, SECRET);
    const r = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      nowSec: ts + 1_000_000_000,
      toleranceSec: Number.POSITIVE_INFINITY,
      allowLegacyTimestampSignature: true,
    });
    expect(r.valid).toBe(true);
  });

  test("rejects a non-numeric timestamp", async () => {
    const sig = await signWebhookPayload(BODY, SECRET);
    const r = await verifyWebhookSignature(BODY, sig, SECRET, "not-a-number");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("bad-timestamp");
  });

  test("rejects garbage in the signature header", async () => {
    const r = await verifyWebhookSignature(
      BODY,
      "definitely-not-hex!!!",
      SECRET,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  test("rejects an empty signature without throwing", async () => {
    const r = await verifyWebhookSignature(BODY, "", SECRET);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("missing-signature");
  });

  // --- v2 scheme: stable nonce + event-type bound signature ---

  const v2Sign = (
    ts: number,
    deliveryId: string,
    eventType: string,
    body: string,
  ) =>
    signWebhookPayload(
      `v2:${ts}.${deliveryId.length}:${deliveryId}.${eventType.length}:${eventType}.${body}`,
      SECRET,
    );

  test("(a) verifies a valid v2 signature and exposes deliveryId", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v2=${await v2Sign(ts, "del-1", "tx_signed", BODY)}`;
    const r = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      eventType: "tx_signed",
      deliveryId: "del-1",
    });
    expect(r.valid).toBe(true);
    expect(r.scheme).toBe("v2");
    expect(r.deliveryId).toBe("del-1");
  });

  test("(b) rejects a v2 signature when the event type header is tampered", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v2=${await v2Sign(ts, "del-1", "tx_signed", BODY)}`;
    const r = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      eventType: "tx_failed", // attacker-supplied header differs from signed value
      deliveryId: "del-1",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  test("(c) rejects a replayed v2 signature whose timestamp is outside the window", async () => {
    const ts = 1_000_000_000;
    const sig = `v2=${await v2Sign(ts, "del-1", "tx_signed", BODY)}`;
    const r = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      nowSec: ts + 1000,
      toleranceSec: 300,
      eventType: "tx_signed",
      deliveryId: "del-1",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stale-timestamp");
  });

  test("rejects a v2 signature replayed under a swapped timestamp within the window", async () => {
    // Re-presenting the captured body with a fresher ts header must not verify.
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v2=${await v2Sign(ts, "del-1", "tx_signed", BODY)}`;
    const r = await verifyWebhookSignature(BODY, sig, SECRET, ts + 1, {
      nowSec: ts,
      eventType: "tx_signed",
      deliveryId: "del-1",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  test("(d) a retried delivery keeps a stable id, timestamp, and v2 signature", async () => {
    // Same deliveryId + signedAt across attempts => identical canonical material => identical sig.
    const ts = Math.floor(Date.now() / 1000);
    const first = `v2=${await v2Sign(ts, "stable-del", "tx_signed", BODY)}`;
    const retry = `v2=${await v2Sign(ts, "stable-del", "tx_signed", BODY)}`;
    expect(retry).toBe(first);
    const r = await verifyWebhookSignature(BODY, retry, SECRET, ts, {
      eventType: "tx_signed",
      deliveryId: "stable-del",
    });
    expect(r.valid).toBe(true);
    expect(r.deliveryId).toBe("stable-del");
  });

  test("rejects a v2 signature missing the delivery id / event type context", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v2=${await v2Sign(ts, "del-1", "tx_signed", BODY)}`;
    const r = await verifyWebhookSignature(BODY, sig, SECRET, ts, {
      eventType: "tx_signed",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });
});
