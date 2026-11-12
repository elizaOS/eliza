/** Preserves explicit single-token verbatim requests without accepting unrelated scaffolds. */
import { expect, test } from "vitest";
import {
  isTerseReplyWorthKeeping,
  isUnusableStage1Reply,
  parseSayLiteralInstruction,
} from "./reply-quality";

test("explicit single-token verbatim requests remain intentional terse replies", () => {
  for (const [messageText, literal] of [
    ["Echo ZEPAQUIN verbatim.", "ZEPAQUIN"],
    ['Please echo "Nubs42" verbatim!', "Nubs42"],
    ["Say PONG", "PONG"],
    ["Reply with the single word: HELLO", "HELLO"],
    ['return "OK" verbatim', "OK"],
  ]) {
    expect(parseSayLiteralInstruction(messageText)).toBe(literal);
    expect(isTerseReplyWorthKeeping({ reply: literal, messageText })).toBe(
      true,
    );
  }
});

test("unrelated prose and additional operations do not become literal instructions", () => {
  for (const messageText of [
    "write a poem",
    "say something nice about cats",
    "Echo ZEPAQUIN verbatim and send an email",
    "Explain the word verbatim",
    'Quote "Echo ZEPAQUIN verbatim"',
    "Echo ZEPAQUIN VERBATIM EXTRA",
  ])
    expect(parseSayLiteralInstruction(messageText)).toBeNull();
});

test("short all-caps scaffolds still fail without an explicit matching instruction", () => {
  expect(isUnusableStage1Reply("ZEPAQUIN")).toBe(true);
  expect(
    isTerseReplyWorthKeeping({
      reply: "ZEPAQUIN",
      messageText: "What can you do?",
    }),
  ).toBe(false);
});

test("verbatim pronoun references require context while quoted pronouns remain literals", () => {
  for (const pronoun of ["it", "this", "that", "them", "these", "those"]) {
    expect(parseSayLiteralInstruction(`Print ${pronoun} verbatim.`)).toBeNull();
    expect(parseSayLiteralInstruction(`Echo "${pronoun}" verbatim.`)).toBe(
      pronoun,
    );
  }
  expect(parseSayLiteralInstruction("Say verbatim")).toBe("verbatim");
});

test("exactly single-token requests preserve the requested reply at the quality boundary", () => {
  for (const messageText of [
    "Reply with exactly READY.",
    "Respond with exactly READY",
    "Please say exactly READY!",
    'Return exactly "READY".',
    "<@123> reply with exactly READY",
    "Reply with exactly READY verbatim.",
    "Reply only READY.",
    "For this preview check, reply only READY. Do not use tools or change anything.",
  ]) {
    expect(parseSayLiteralInstruction(messageText)).toBe("READY");
    expect(isUnusableStage1Reply("READY")).toBe(true);
    expect(isTerseReplyWorthKeeping({ reply: "READY", messageText })).toBe(
      true,
    );
    expect(isTerseReplyWorthKeeping({ reply: "WRONG", messageText })).toBe(
      false,
    );
  }
});

test("exactly does not turn prose, quoted requests or extra actions into literal authority", () => {
  for (const messageText of [
    "Explain exactly why READY is shown",
    "Write exactly a poem",
    "Reply with exactly READY and send an email",
    "Reply with exactly READY or WAIT",
    'Quote "Reply with exactly READY"',
    "Do not reply with exactly READY",
    "Reply with exactly it verbatim",
    "Reply with exactly READY tomorrow",
    "Reply with exactly shouldRespond: true",
    "For this check, reply only READY. Then send an email.",
    'Quote "reply only READY". Do not use tools.',
  ]) {
    expect(parseSayLiteralInstruction(messageText)).toBeNull();
    expect(isTerseReplyWorthKeeping({ reply: "READY", messageText })).toBe(
      false,
    );
  }
  expect(isUnusableStage1Reply("READY")).toBe(true);
  expect(
    isTerseReplyWorthKeeping({
      reply: "READY",
      messageText: "What can you do?",
    }),
  ).toBe(false);
  expect(
    isTerseReplyWorthKeeping({
      reply: "I cannot",
      messageText: "Reply with exactly READY.",
    }),
  ).toBe(false);
});
