/**
 * Deterministic webhook contract tests cover subscription verification, raw
 * body signatures, multi-account demultiplexing, and stable replay identities.
 */
import { createHmac } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { parseInstagramWebhookDelivery, verifyInstagramWebhookChallenge } from "../webhook.js";

const SECRET = "webhook-app-secret";

function signed(value: unknown): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(value));
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return { body, signature };
}

describe("Instagram webhook boundary", () => {
  it("returns a valid challenge and rejects the wrong verification token", () => {
    const query = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-me",
      "hub.challenge": "challenge-123",
    });
    expect(verifyInstagramWebhookChallenge(query, "verify-me")).toBe("challenge-123");
    expect(() => verifyInstagramWebhookChallenge(query, "wrong")).toThrow(ElizaError);
  });

  it("verifies raw bytes and demultiplexes stable event IDs by professional account", () => {
    const delivery = signed({
      object: "instagram",
      entry: [
        {
          id: "account-a",
          time: 1_777_000_000,
          messaging: [
            {
              sender: { id: "user-a" },
              recipient: { id: "account-a" },
              message: { mid: "message-a", text: "private content" },
            },
          ],
        },
        {
          id: "account-b",
          time: 1_777_000_001,
          changes: [{ field: "comments", value: { id: "comment-b", text: "public" } }],
        },
      ],
    });
    const first = parseInstagramWebhookDelivery(delivery.body, delivery.signature, SECRET);
    const replay = parseInstagramWebhookDelivery(delivery.body, delivery.signature, SECRET);
    expect(first.map((change) => change.accountId)).toEqual(["account-a", "account-b"]);
    expect(first.map((change) => change.eventId)).toEqual([
      "account-a:messages:message-a",
      "account-b:comments:comment-b",
    ]);
    expect(replay.map((change) => change.eventId)).toEqual(first.map((change) => change.eventId));
  });

  it("keeps fallback replay IDs stable across restart-like receipt times", () => {
    const delivery = signed({
      object: "instagram",
      entry: [
        {
          id: "account-a",
          messaging: [
            {
              sender: { id: "user-a" },
              recipient: { id: "account-a" },
              message: { text: "delivery without provider id or time" },
            },
          ],
        },
      ],
    });
    const beforeRestart = parseInstagramWebhookDelivery(
      delivery.body,
      delivery.signature,
      SECRET,
      1_700_000_000_000
    );
    const afterRestart = parseInstagramWebhookDelivery(
      delivery.body,
      delivery.signature,
      SECRET,
      1_800_000_000_000
    );
    expect(afterRestart[0]?.eventId).toBe(beforeRestart[0]?.eventId);
    expect(afterRestart[0]?.receivedAt).not.toBe(beforeRestart[0]?.receivedAt);
    expect(beforeRestart[0]?.eventId).toMatch(/^account-a:messages:[a-f0-9]{64}:0:0$/);
  });

  it("rejects tampering, malformed envelopes, and missing signatures before routing", () => {
    const delivery = signed({ object: "instagram", entry: [] });
    const tampered = Buffer.from(delivery.body);
    tampered[tampered.length - 1] = 0x20;
    for (const [body, signature] of [
      [tampered, delivery.signature],
      [delivery.body, null],
    ] as const) {
      const error = (() => {
        try {
          parseInstagramWebhookDelivery(body, signature, SECRET);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("INSTAGRAM_WEBHOOK_UNAUTHORIZED");
    }
  });
});
