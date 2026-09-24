/** Exercises local-link extraction against literal code fences and real benchmark documentation. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { markdownLinks } from "./check-markdown-links.mjs";

test("fenced code cannot create links or hide subsequent prose links", () => {
  const markdown = [
    "[before](before.md)",
    "````markdown",
    "```python",
    "[regex]([0-9.]+)",
    "```",
    "````",
    "~~~text",
    "[example](missing.md)",
    "`````",
    "~~~~",
    "[after](after.md)",
    "    - [nested list](nested.md)",
  ].join("\n");
  assert.deepEqual(markdownLinks(markdown), [
    "before.md",
    "after.md",
    "nested.md",
  ]);
});

test("inline code stays literal while link labels and references remain readable", () => {
  assert.deepEqual(
    markdownLinks(
      "`[code](fake.md)` [`runtime`](runtime.md)\n[guide]: guide.md",
    ),
    ["runtime.md", "guide.md"],
  );
});

test("an unclosed fence keeps the remaining example literal", () => {
  assert.deepEqual(
    markdownLinks("[guide](guide.md)\n```python\n[example](fake.md)"),
    ["guide.md"],
  );
});

test("the preserved boto task's version regex is not a documentation link", () => {
  const source = readFileSync(
    new URL(
      "../benchmarks/suites/nl2repo/test_files/boto/start.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(source.includes("([0-9.]+)"));
  assert.ok(!markdownLinks(source).includes("[0-9.]+"));
});
