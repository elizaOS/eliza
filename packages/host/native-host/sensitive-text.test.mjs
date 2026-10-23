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

test("the gate refuses only a remembered value, not what scrubbing would change", () => {
  const gate = createSensitiveTextGate();
  assert.throws(() => gate.require(`my verification code is ${CODE}`));
  const size = gate.scrubber.size;
  // An amount after "code" is neither sensitive nor remembered.
  gate.require("the discount code costs 12.50");
  gate.require("I paid 1250 dollars");
  gate.require("the code costs 1,250 now");
  assert.equal(gate.scrubber.size, size);
  assert.throws(() => gate.require(`use ${CODE} like before`));
});

test("an amount after a code word stays", () => {
  for (const text of [
    "the discount code costs 12.50",
    "the code costs 48.29 today",
    "the code costs 1,250 now",
    "my code is 12.50",
    "the code is 1,250",
    "1,250 is my code",
    "my passcode is 48.29 now",
  ]) {
    assert.equal(redactSensitiveText(text), text, text);
    const scrubber = createSecretScrubber();
    assert.equal(scrubber.scrub(text), text, text);
    assert.equal(scrubber.size, 0, text);
  }
  assert.equal(
    redactSensitiveText("the code is 4, 8, 2, 9"),
    `the code is ${MARK}`,
  );
});

test("a password followed by a comma and more words is remembered alone", () => {
  const scrubber = createSecretScrubber();
  assert.equal(
    scrubber.scrub("password is hunter2,please call"),
    `password is ${MARK}`,
  );
  assert.equal(
    scrubber.scrub("I typed hunter2 again"),
    `I typed ${MARK} again`,
  );
  assert.equal(scrubber.scrub("please call me"), "please call me");
  assert.equal(scrubber.scrub("password is abc9,"), `password is ${MARK},`);
  assert.equal(scrubber.scrub("I typed abc9 again"), `I typed ${MARK} again`);
  const gate = createSensitiveTextGate();
  assert.throws(() => gate.require("password is hunter2;please call"));
  assert.throws(() => gate.require("I typed hunter2 again"));
  gate.require("please call me");
});

test("only the value after a password is remembered, not the rest of its sentence", () => {
  const gate = createSensitiveTextGate();
  assert.throws(() =>
    gate.require(
      "my password is hunter2 and I paid 1250 dollars for room 2b4c",
    ),
  );
  assert.equal(gate.scrubber.size, 1);
  gate.require("I paid 1250 dollars");
  gate.require("room 2b4c");
  assert.throws(() => gate.require("I typed hunter2 again"));

  const talk = createSensitiveTextGate();
  assert.throws(() => talk.require("password is not working since 10/23/2026"));
  assert.equal(talk.scrubber.size, 0);
  talk.require("since 10/23/2026");

  const key = createSensitiveTextGate();
  assert.throws(() =>
    key.require("api key is abc123xyz and I paid 1250 dollars"),
  );
  key.require("I paid 1250 dollars");
  assert.throws(() => key.require("abc123xyz"));
});

test("what follows a comma inside a password value is not remembered alone", () => {
  const gate = createSensitiveTextGate();
  assert.throws(() => gate.require("password is hunter2,2024"));
  gate.require("back in 2024");
  assert.throws(() => gate.require("use hunter2 now"));
  assert.throws(() => gate.require("use hunter2,2024 now"));

  // An all-digit value: only the digits before the comma are remembered.
  const digits = createSensitiveTextGate();
  assert.throws(() => digits.require("password is 4829,2024"));
  digits.require("back in 2024");
  assert.throws(() => digits.require("use 4829 now"));
  assert.throws(() => digits.require("use 4829,2024 now"));
});

test("a zip code in a refused sentence is not remembered", () => {
  const gate = createSensitiveTextGate();
  assert.throws(() =>
    gate.require("my password is hunter2. 90210 is my zip code"),
  );
  assert.equal(gate.scrubber.size, 1);
  gate.require("I live in 90210");
  assert.throws(() => gate.require("use hunter2"));
  for (const text of ["90210 is my zip code", "4829 is our area code"])
    assert.equal(redactSensitiveText(text), text, text);
});

test("an amount with a decimal or thousands separator after a code word stays", () => {
  for (const text of [
    "the code costs 1250.75",
    "the code costs 4829,50 now",
    "1250.75 is the code",
    "12.4829 is the code",
  ]) {
    assert.equal(containsSensitiveText(text), false, text);
    assert.equal(redactSensitiveText(text), text, text);
  }
  assert.equal(
    redactSensitiveText("the code is 4829."),
    `the code is ${MARK}.`,
  );
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
