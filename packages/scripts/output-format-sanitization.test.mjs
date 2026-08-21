/** Exercises generated Markdown output against delimiter and line-break injection. */
import assert from "node:assert/strict";
import test from "node:test";
import { buildVerdictMarkdown } from "../../scripts/ai-qa/review-walkthrough.mjs";
import { encodeMarkdownTableCell } from "./markdown-table-cell.mjs";

test("Markdown cells escape syntax before normalizing every line separator", () => {
  assert.equal(
    encodeMarkdownTableCell("a\\|b\r\nc\rd\ne\u2028f\u2029g"),
    "a\\\\\\|b c d e f g",
  );
  assert.equal(encodeMarkdownTableCell("a\rb", "<br />"), "a<br />b");
});

test("walkthrough output keeps untrusted model notes in exactly one table row", () => {
  const markdown = buildVerdictMarkdown({
    runId: "run",
    model: "model",
    lane: "lane",
    totals: { good: 0, "needs-work": 1, broken: 0, error: 0, total: 1 },
    results: [
      {
        stepN: 1,
        stepId: "step",
        viewport: "desktop",
        verdict: "needs-work",
        reasons: ["note\\|injected\r| forged | row |\u2028tail"],
      },
    ],
  });
  const resultRows = markdown
    .split("\n")
    .filter((line) => line.startsWith("| 1 step |"));
  assert.equal(resultRows.length, 1);
  assert.match(
    resultRows[0],
    /note\\\\\\\|injected \\| forged \\| row \\| tail/,
  );
});
