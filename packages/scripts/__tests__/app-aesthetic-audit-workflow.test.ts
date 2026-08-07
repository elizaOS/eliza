/**
 * Fail-closed contract for the app visual-audit workflow. Contributor code
 * runs on a disposable host, and a green check certifies both the DOM verdict
 * and pixel OCR rather than only proving that an artifact upload ran.
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
  test("runs contributor code on a hosted runner with a complete-audit budget", () => {
    const auditJob = jobBlock("aesthetic-audit");
    expect(auditJob).toMatch(/^\s{4}runs-on:\s*ubuntu-24\.04$/m);
    expect(auditJob).toMatch(/^\s{4}timeout-minutes:\s*75$/m);
    expect(auditJob).not.toContain("self-hosted");
    expect(auditJob).not.toContain("hetzner-robot");
  });

  test("fails closed at both report boundaries", () => {
    const auditJob = jobBlock("aesthetic-audit");
    const ocrJob = jobBlock("ocr-content-audit");

    expect(auditJob).not.toContain("continue-on-error");
    expect(ocrJob).not.toContain("continue-on-error");
    expect(auditJob).toContain(
      "run: bun run --cwd packages/app audit:app:capture",
    );
    expect(ocrJob).toContain("run: bun run --cwd packages/app audit:ocr");
    expect(ocrJob).toMatch(
      /name: Download aesthetic-audit artifacts\n\s+uses:/,
    );
  });
});
