import assert from "node:assert/strict";
import test from "node:test";
import { proposedRecordingSummary } from "../src/client/notes-recording-summary.ts";

test("only an exact summary and action list becomes an editable proposal", () => {
  const answer = {
    summary: "Decided to ship Friday.",
    actions: [" Email Sam ", "Book room"],
  };
  assert.deepEqual(proposedRecordingSummary(JSON.stringify(answer)), {
    summary: "Decided to ship Friday.",
    actions: ["Email Sam", "Book room"],
  });
  assert.deepEqual(
    proposedRecordingSummary(
      `\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\n`,
    ),
    { summary: "Decided to ship Friday.", actions: ["Email Sam", "Book room"] },
  );
  assert.deepEqual(
    proposedRecordingSummary(
      `\`\`\`\n${JSON.stringify({ summary: "S", actions: [] })}\n\`\`\``,
    ),
    { summary: "S", actions: [] },
  );
});

test("prose, extra fields and out-of-bounds answers are reviewed as text instead", () => {
  const refused = [
    "We decided to ship Friday.",
    "",
    "null",
    "[]",
    JSON.stringify({ summary: "S" }),
    JSON.stringify({ summary: "S", actions: [], save: true }),
    JSON.stringify({ summary: " ", actions: [] }),
    JSON.stringify({ summary: "S\0", actions: [] }),
    JSON.stringify({ summary: "x".repeat(32001), actions: [] }),
    JSON.stringify({ summary: "S", actions: "Email Sam" }),
    JSON.stringify({ summary: "S", actions: Array(21).fill("a") }),
    JSON.stringify({ summary: "S", actions: [" "] }),
    JSON.stringify({ summary: "S", actions: [7] }),
    JSON.stringify({ summary: "S", actions: ["two\nlines"] }),
    JSON.stringify({ summary: "S", actions: ["x".repeat(501)] }),
    JSON.stringify({ summary: "S", actions: Array(10).fill("y".repeat(450)) }),
    `Here it is: ${JSON.stringify({ summary: "S", actions: [] })}`,
    `\`\`\`json\n${JSON.stringify({ summary: "S", actions: [] })}`,
    "x".repeat(48001),
  ];
  for (const text of refused)
    assert.equal(proposedRecordingSummary(text), undefined, text.slice(0, 80));
  assert.equal(proposedRecordingSummary(undefined), undefined);
});
