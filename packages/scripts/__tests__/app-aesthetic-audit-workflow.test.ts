/**
 * Static contract for the app visual-audit workflow. The audit is valuable
 * reviewer evidence, but it is deliberately advisory for develop throughput:
 * failures must stay visible in logs and artifacts without turning the
 * non-required workflow into a merge-blocking queue drain (#14051).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL(
    "../../../.github/workflows/app-aesthetic-audit.yml",
    import.meta.url,
  ),
  "utf8",
);

function jobBlock(jobId: string): string {
  const lines = workflowText.split(/\r?\n/);
  const start = lines.indexOf(`  ${jobId}:`);
  if (start < 0) {
    throw new Error(`Missing app aesthetic workflow job: ${jobId}`);
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

describe("app-aesthetic-audit workflow", () => {
  test("keeps visual audit jobs advisory at the job boundary", () => {
    expect(jobBlock("aesthetic-audit")).toMatch(
      /^\s{4}continue-on-error:\s*true$/m,
    );
    expect(jobBlock("ocr-content-audit")).toMatch(
      /^\s{4}continue-on-error:\s*true$/m,
    );
  });

  test("does not fail OCR triage when the advisory screenshot artifact is absent", () => {
    expect(jobBlock("ocr-content-audit")).toMatch(
      /name: Download aesthetic-audit artifacts\n\s+continue-on-error:\s*true/,
    );
  });
});
