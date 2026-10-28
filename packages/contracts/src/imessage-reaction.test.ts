import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  IMESSAGE_CLASSIC_REACTIONS,
  parseImessageReaction,
} from "./imessage-reaction.ts";

const accepted = [
  ...IMESSAGE_CLASSIC_REACTIONS,
  "😀",
  "❤",
  "❤️",
  "👍🏽",
  "👩🏽‍💻",
  "👨‍👩‍👧‍👦",
  "🇯🇵",
  "1️⃣",
  "#️⃣",
  "🏳️‍🌈",
  "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
];
const rejected: unknown[] = [
  undefined,
  null,
  {},
  1,
  "",
  "none",
  "Like",
  "+like",
  "-love",
  "+😂",
  "-😂",
  "😀😀",
  "👍 🥳",
  "great 👍",
  "ok",
  "1",
  "#",
  "*",
  "🏽",
  "🇯",
  "\u200d",
  "a\u200d",
  "😀\n",
  "😀\u200b",
  "\u202e😀",
  " 😀",
  "😀 ",
  "❤︎",
  "☀️hello",
  "A️",
];

describe("one canonical add-only reaction choice", () => {
  for (const value of accepted)
    test(`accept ${JSON.stringify(value)}`, () =>
      assert.equal(parseImessageReaction(value), value));
  for (const value of rejected)
    test(`reject ${JSON.stringify(value)}`, () =>
      assert.equal(parseImessageReaction(value), undefined));
});
