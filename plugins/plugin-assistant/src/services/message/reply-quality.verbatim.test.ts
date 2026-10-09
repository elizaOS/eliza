/** Preserves explicit single-token verbatim requests without accepting unrelated scaffolds. */
import { expect, test } from "bun:test";
import { isTerseReplyWorthKeeping, isUnusableStage1Reply, parseSayLiteralInstruction } from "./reply-quality";

test("explicit single-token verbatim requests remain intentional terse replies", () => {
	for (const [messageText, literal] of [
		["Echo ZEPAQUIN verbatim.", "ZEPAQUIN"],
		['Please echo "Nubs42" verbatim!', "Nubs42"],
		["Say PONG", "PONG"],
		["Reply with the single word: HELLO", "HELLO"],
		['return "OK" verbatim', "OK"],
	]) {
		expect(parseSayLiteralInstruction(messageText)).toBe(literal);
		expect(isTerseReplyWorthKeeping({ reply: literal, messageText })).toBe(true);
	}
});

test("unrelated prose and additional operations do not become literal instructions", () => {
	for (const messageText of [
		"write a poem", "say something nice about cats",
		"Echo ZEPAQUIN verbatim and send an email", "Explain the word verbatim",
		'Quote "Echo ZEPAQUIN verbatim"', "Echo ZEPAQUIN VERBATIM EXTRA",
	]) expect(parseSayLiteralInstruction(messageText)).toBeNull();
});

test("short all-caps scaffolds still fail without an explicit matching instruction", () => {
	expect(isUnusableStage1Reply("ZEPAQUIN")).toBe(true);
	expect(isTerseReplyWorthKeeping({ reply: "ZEPAQUIN", messageText: "What can you do?" })).toBe(false);
});

 test("verbatim pronoun references require context while quoted pronouns remain literals", () => {
  for (const pronoun of ["it", "this", "that", "them", "these", "those"]) {
    expect(parseSayLiteralInstruction(`Print ${pronoun} verbatim.`)).toBeNull();
    expect(parseSayLiteralInstruction(`Echo "${pronoun}" verbatim.`)).toBe(pronoun);
  }
  expect(parseSayLiteralInstruction("Say verbatim")).toBe("verbatim");
});
