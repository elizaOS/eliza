import assert from "node:assert/strict";
import test from "node:test";
import { NativeHostError } from "./errors.mjs";
import {
  containsSensitiveText,
  requireNonSensitiveText,
} from "./sensitive-text.mjs";

test("sensitive text is rejected wholly without echoing synthetic protected values", () => {
  for (const text of [
    "password: fictional-secret",
    "API key is sk-proj-fictional01234567890123456789",
    "verification code is 123456",
    "123456",
    "Card 4111 1111 1111 1111",
    "Bearer fictional0123456789012345",
    "-----BEGIN PRIVATE KEY-----",
    "ｐａｓｓｗｏｒｄ： fictional-secret",
  ]) {
    assert.equal(containsSensitiveText(text), true);
    assert.throws(
      () => requireNonSensitiveText(text),
      (error) =>
        error instanceof NativeHostError &&
        error.status === 422 &&
        error.code === "SENSITIVE_TEXT" &&
        !error.message.includes(text),
    );
  }
  for (const text of [
    "Help me change my password",
    "What is a verification code?",
    "My bill is $125.00",
    "Call 202-555-0134",
    "The year is 2026.",
  ]) {
    assert.equal(containsSensitiveText(text), false);
    assert.doesNotThrow(() => requireNonSensitiveText(text));
  }
});
