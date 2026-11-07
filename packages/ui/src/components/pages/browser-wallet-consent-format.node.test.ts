import assert from "node:assert/strict";
import test from "node:test";
import { decodeSignableMessage } from "./browser-wallet-consent-format.ts";

test("decodes a 0X-prefixed personal_sign payload for the consent preview", () => {
  assert.equal(decodeSignableMessage("0x4869"), "Hi");
  // EIP-1193 hex prefixes are case-insensitive. 0X currently stays hex,
  // so the sign dialog shows "0X4869" instead of the text "Hi".
  assert.equal(decodeSignableMessage("0X4869"), "Hi");
  assert.equal(decodeSignableMessage(" \t0X4869\n"), "Hi");
});

test("leaves a non-hex 0X payload unchanged", () => {
  assert.equal(decodeSignableMessage("0X686"), "0X686");
  assert.equal(decodeSignableMessage("0X68zz"), "0X68zz");
  assert.equal(decodeSignableMessage("Sign this"), "Sign this");
  assert.equal(decodeSignableMessage("  Sign this  "), "  Sign this  ");
  assert.equal(decodeSignableMessage("  0X68zz  "), "  0X68zz  ");
});
