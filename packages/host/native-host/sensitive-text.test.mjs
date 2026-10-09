import assert from "node:assert/strict";
import test from "node:test";
import { containsSensitiveText } from "./sensitive-text.mjs";

test("spoken and spaced verification codes are recognized", () => {
  for (const text of [
    "123456",
    "1 2 3 4 5 6",
    "4821-77",
    "four eight two one",
    "Four, eight, two, one, seven, seven.",
    "the verification code is one two three four five six",
    "my sign in code is 1 2 3 4",
    // A spoken card number passes the same checksum as a typed one.
    "four two four two four two four two four two four two four two four two",
  ])
    assert.equal(containsSensitiveText(text), true, text);
});

test("ordinary speech with numbers is not withheld", () => {
  for (const text of [
    "12.50",
    "1,000",
    "pay the water bill",
    "I have one or two questions",
    "call me at three",
    "the bill is one hundred and twenty dollars",
  ])
    assert.equal(containsSensitiveText(text), false, text);
});
