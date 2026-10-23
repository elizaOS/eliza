import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  containsSensitiveText,
  createSecretScrubber,
  createSensitiveTextGate,
  luhn,
  redactSensitiveText,
  requireNonSensitiveText,
  SECRET_REMOVED_MARK,
  SENSITIVE_TEXT_REFUSAL,
} from "./sensitive-text.mjs";

test("spoken and spaced verification codes are recognized", () => {
  for (const text of [
    "123456",
    "1 2 3 4 5 6",
    "4821-77",
    "four eight two one",
    "Four, eight, two, one, seven, seven.",
    "the verification code is one two three four five six",
    "my sign in code is 1 2 3 4",
    // A plain "code" in ordinary words.
    "my code is one two three four",
    "my code is one two three four five six",
    "the code is 4 8 2 9 1 7",
    "The code is 4 8 1 5 1 6.",
    "the code is 482917",
    "my code is 482917",
    "the code they sent is 4 8 2 9 1 7",
    "482917 is the code",
    "four eight two nine one seven is my code",
    "code: 482-917",
    "482 917",
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
    // A phone number, a time and an address code are not secrets.
    "555-1234",
    "10 30",
    "my zip code is 90210",
    "the area code is 415",
    "the postal code is 10115",
    "94110 is my zip code",
    "10115 is our postal code",
    "415 is the area code",
    "the code they sent did not work",
  ])
    assert.equal(containsSensitiveText(text), false, text);
});

// Fictional canaries only, never a real credential.
const CODE = "482917";
const CARD = "4111111111111111";
const PASSWORD = "hunter2-fiction";
const MARK = SECRET_REMOVED_MARK;

test("a detected secret is removed with its telling words kept and remembered", () => {
  const scrubber = createSecretScrubber();
  for (const [said, kept] of [
    ["my verification code is 4 8 2 9 1 7", `my verification code is ${MARK}`],
    ["482917 is the code", `${MARK} is the code`],
    [`my password is ${PASSWORD} and then sign in`, `my password is ${MARK}`],
    ["Card 4111 1111 1111 1111 please", `Card ${MARK} please`],
    ["Bearer fictional0123456789012345", `Bearer ${MARK}`],
    ["four eight two nine one seven", MARK],
  ])
    assert.equal(scrubber.scrub(said), kept, said);
  for (const [said, kept] of [
    [`use ${CODE} like before`, `use ${MARK} like before`],
    ["it was four eight two nine one seven", `it was ${MARK}`],
    ["I said 4829 then stopped", `I said ${MARK} then stopped`],
    [`I typed ${PASSWORD} again`, `I typed ${MARK} again`],
    ["it starts 4111 1111 1111", `it starts ${MARK}`],
  ])
    assert.equal(scrubber.scrub(said), kept, said);
  for (const text of [
    "the card ending 1111 is fine",
    "My bill is $48.29",
    "Call 555-482-9170",
    "my zip code is 90210",
  ])
    assert.equal(scrubber.scrub(text), text, text);
  const record = scrubber.scrubValue({ at: 1, text: [`use ${CODE}`] });
  assert.deepEqual(record, { at: 1, text: [`use ${MARK}`] });
  assert.ok(!inspect(scrubber, { depth: 10, showHidden: true }).includes(CODE));
  scrubber.clear();
  assert.equal(scrubber.scrub(`use ${CODE}`), `use ${CODE}`);
  assert.equal(redactSensitiveText(`use ${CODE}`), `use ${CODE}`);
});

test("punctuation inside a password is removed with it", () => {
  const scrubber = createSecretScrubber();
  assert.equal(
    scrubber.scrub(`my password: ${PASSWORD}!9.x and more`),
    `my password: ${MARK}`,
  );
  assert.equal(
    scrubber.scrub(`my password is ${PASSWORD}. Then sign in`),
    `my password is ${MARK}. Then sign in`,
  );
  assert.equal(scrubber.scrub(`It is ${PASSWORD}!9.x`), `It is ${MARK}`);
});

test("a value that is not a string is refused, not checked as its name", () => {
  for (const value of [undefined, null, 42, { text: "my pin is 1234" }])
    assert.throws(
      () => requireNonSensitiveText(value),
      (error) => error.status === 400 && error.code === "INVALID_TEXT",
    );
});

test("talking about a password remembers no ordinary word", () => {
  const scrubber = createSecretScrubber();
  assert.equal(
    scrubber.scrub("my password is not working"),
    `my password is ${MARK}`,
  );
  assert.equal(scrubber.size, 0);
  assert.equal(scrubber.scrub("it is not working"), "it is not working");
});

test("the gate refuses a remembered value again without its telling words", () => {
  const gate = createSensitiveTextGate();
  const refused = (text) =>
    assert.throws(
      () => gate.require(text),
      (error) =>
        error.status === 422 &&
        error.code === "SENSITIVE_TEXT" &&
        error.message === SENSITIVE_TEXT_REFUSAL,
      text,
    );
  gate.require(`use ${CODE} like before`);
  refused("my verification code is 4 8 2 9 1 7");
  refused(`use ${CODE} like before`);
  gate.require("Pay my water bill");
  gate.clear();
  gate.require(`use ${CODE} like before`);
});

test("a host matcher adds its own values to the check, the scrubber and the gate", () => {
  // A host-specific value: "member id" followed by eight digits.
  const memberId = {
    *spans(text) {
      for (const match of text.matchAll(/\bmember id\s+(\d{8})\b/gi)) {
        const start = match.index + match[0].length - match[1].length;
        yield [start, start + match[1].length];
      }
    },
  };
  const matchers = [memberId];
  assert.equal(containsSensitiveText("member id 12345678"), false);
  assert.equal(containsSensitiveText("member id 12345678", { matchers }), true);
  assert.equal(
    containsSensitiveText("member id one two three four five six seven eight", {
      matchers,
    }),
    true,
  );
  assert.throws(() =>
    requireNonSensitiveText("member id 12345678", { matchers }),
  );
  const scrubber = createSecretScrubber({ matchers });
  assert.equal(
    scrubber.scrub("my member id 12345678 ok"),
    `my member id ${MARK} ok`,
  );
  assert.equal(scrubber.scrub("it is 12345678"), `it is ${MARK}`);
  const gate = createSensitiveTextGate({ matchers });
  assert.throws(() => gate.require("member id 12345678"));
  assert.throws(() => gate.require("again 12345678"));
});

test("luhn accepts a card checksum only", () => {
  assert.equal(luhn(CARD), true);
  assert.equal(luhn("4111111111111112"), false);
  assert.equal(luhn("0000000000000000"), false);
  assert.equal(luhn("123456"), false);
});
