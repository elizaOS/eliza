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
