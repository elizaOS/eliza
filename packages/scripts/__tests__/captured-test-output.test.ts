/**
 * Exercises the bounded package-output formatter with deterministic synthetic
 * Vitest output, including ANSI escapes and chunk-split failure lines.
 */
import { describe, expect, test } from "bun:test";
import {
  appendCapturedTestOutput,
  createCapturedTestOutput,
  formatCapturedTestOutput,
  MAX_CAPTURED_OUTPUT_CHARS,
} from "../lib/captured-test-output.mjs";

describe("captured test output", () => {
  test("leaves uncapped output intact and indexes failing files", () => {
    const capture = createCapturedTestOutput();
    appendCapturedTestOutput(
      capture,
      " FAIL  src/first.test.ts > first case\nordinary detail\n",
    );

    const formatted = formatCapturedTestOutput(capture, "package#test");

    expect(formatted).not.toContain("TRUNCATED");
    expect(formatted).toContain("ordinary detail");
    expect(formatted).toContain("[eliza-test] FAILING_FILE src/first.test.ts");
  });

  test("reports truncation and preserves every failing file from discarded detail", () => {
    const capture = createCapturedTestOutput();
    appendCapturedTestOutput(
      capture,
      "\u001b[31m FAIL  src/early-one.test.ts > one\u001b[39m\n",
    );
    appendCapturedTestOutput(capture, " FAIL  src/early-");
    appendCapturedTestOutput(capture, "two.spec.tsx > two\n");
    appendCapturedTestOutput(capture, "x".repeat(MAX_CAPTURED_OUTPUT_CHARS));
    appendCapturedTestOutput(
      capture,
      "\n FAIL  src/retained.test.mts > last\n",
    );

    const formatted = formatCapturedTestOutput(capture, "package#test");

    expect(formatted).toMatch(
      /TRUNCATED \d+ earlier character\(s\) omitted; 2 earlier failing test file\(s\) omitted/,
    );
    expect(formatted).toContain(
      "[eliza-test] FAILING_FILE src/early-one.test.ts",
    );
    expect(formatted).toContain(
      "[eliza-test] FAILING_FILE src/early-two.spec.tsx",
    );
    expect(formatted).toContain(
      "[eliza-test] FAILING_FILE src/retained.test.mts",
    );
    expect(formatted.match(/\[eliza-test\] FAILING_FILE /g)).toHaveLength(3);
  });

  test("deduplicates repeated failure detail", () => {
    const capture = createCapturedTestOutput();
    appendCapturedTestOutput(capture, " FAIL  src/repeated.test.ts > first\n");
    appendCapturedTestOutput(capture, " FAIL  src/repeated.test.ts > second\n");

    const formatted = formatCapturedTestOutput(capture, "package#test");

    expect(formatted.match(/\[eliza-test\] FAILING_FILE /g)).toHaveLength(1);
  });

  test("tracks split stdout and stderr lines independently", () => {
    const capture = createCapturedTestOutput();
    appendCapturedTestOutput(capture, " FAIL  src/stdout-", "stdout");
    appendCapturedTestOutput(
      capture,
      " FAIL  |browser| src/stderr.spec.ts > case\n",
      "stderr",
    );
    appendCapturedTestOutput(capture, "file.test.ts > case\n", "stdout");

    const formatted = formatCapturedTestOutput(capture, "package#test");

    expect(formatted).toContain("[eliza-test] FAILING_FILE src/stderr.spec.ts");
    expect(formatted).toContain(
      "[eliza-test] FAILING_FILE src/stdout-file.test.ts",
    );
  });
});
