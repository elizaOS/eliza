import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodePairingPayload, type PairingPayload } from "./session-client";

function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function isValidPairingPayload(value: unknown): value is PairingPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.agentId === "string" &&
    record.agentId.trim().length > 0 &&
    typeof record.pairingCode === "string" &&
    record.pairingCode.trim().length > 0 &&
    typeof record.ingressUrl === "string" &&
    record.ingressUrl.trim().length > 0 &&
    typeof record.sessionToken === "string" &&
    record.sessionToken.trim().length > 0
  );
}

describe("decodePairingPayload", () => {
  it("decodes and trims a complete pairing payload", () => {
    expect(
      decodePairingPayload(
        encodePayload({
          agentId: " agent-1 ",
          pairingCode: " code-1 ",
          ingressUrl: " wss://relay.example/input ",
          sessionToken: " token-1 ",
        }),
      ),
    ).toEqual({
      agentId: "agent-1",
      pairingCode: "code-1",
      ingressUrl: "wss://relay.example/input",
      sessionToken: "token-1",
    });
  });

  it.each([
    ["not base64", "%%%"],
    ["not JSON", Buffer.from("nope", "utf8").toString("base64")],
    ["array payload", encodePayload([])],
    ["missing field", encodePayload({ agentId: "agent-1" })],
    [
      "blank session token",
      encodePayload({
        agentId: "agent-1",
        pairingCode: "code-1",
        ingressUrl: "wss://relay.example/input",
        sessionToken: " ",
      }),
    ],
  ])("rejects malformed pairing payloads: %s", (_label, raw) => {
    expect(() => decodePairingPayload(raw)).toThrow();
  });

  it("fuzzes arbitrary JSON payloads into either trimmed payloads or errors", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const encoded = encodePayload(payload);
        if (isValidPairingPayload(payload)) {
          expect(decodePairingPayload(encoded)).toEqual({
            agentId: payload.agentId.trim(),
            pairingCode: payload.pairingCode.trim(),
            ingressUrl: payload.ingressUrl.trim(),
            sessionToken: payload.sessionToken.trim(),
          });
        } else {
          expect(() => decodePairingPayload(encoded)).toThrow();
        }
      }),
      { numRuns: 300 },
    );
  });
});
