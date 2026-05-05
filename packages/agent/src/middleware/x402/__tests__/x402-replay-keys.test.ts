import { describe, expect, it } from "vitest";

import {
  collectReplayKeysToCheck,
  decodePaymentProofForParsing,
  replayKeysFromProofString,
} from "../x402-replay-keys.ts";

describe("x402-replay-keys", () => {
  it("maps the same evm-tx key for plain vs base64-wrapped payload containing a tx hash", () => {
    const hash =
      "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const plain = JSON.stringify({ note: hash });
    const b64 = Buffer.from(plain, "utf8").toString("base64");
    const plainKeys = replayKeysFromProofString(plain).filter((k) =>
      k.startsWith("evm-tx:"),
    );
    const b64Keys = replayKeysFromProofString(b64).filter((k) =>
      k.startsWith("evm-tx:"),
    );
    expect(plainKeys).toEqual([`evm-tx:${hash.toLowerCase()}`]);
    expect(b64Keys).toEqual(plainKeys);
  });

  it("decodePaymentProofForParsing leaves raw 0x tx-shaped strings intact", () => {
    const hash =
      "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    expect(decodePaymentProofForParsing(hash)).toBe(hash);
  });

  it("decodePaymentProofForParsing unwraps base64-wrapped printable JSON", () => {
    const inner = '{"hello":"world"}';
    const b64 = Buffer.from(inner, "utf8").toString("base64");
    expect(decodePaymentProofForParsing(b64)).toBe(inner);
  });

  it("includes facilitator and on-chain keys in collectReplayKeysToCheck", () => {
    const hash =
      "0x1111111111111111111111111111111111111111111111111111111111111111";
    const wrapped = Buffer.from(JSON.stringify({ tx: hash }), "utf8").toString(
      "base64",
    );
    const keys = collectReplayKeysToCheck(wrapped, "pay_abc");
    expect(keys.some((k) => k.startsWith("fac:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("evm-tx:"))).toBe(true);
  });
});
