/** Exercises durable audit aggregation with real temporary files and independent producer processes. */
// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readAuditFindings,
  writeAuditFinding,
} from "../ui-smoke/aesthetic-audit-report";

let outputDir: string;
beforeEach(async () => {
  outputDir = await mkdtemp(path.join(os.tmpdir(), "audit-report-"));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

it("retains completed rows when another worker continues after a failure", async () => {
  const first = { slug: "chat", viewport: "desktop", verdict: "good" };
  const second = {
    slug: "computer-use",
    viewport: "mobile",
    verdict: "needs-eyeball",
  };
  await writeAuditFinding(outputDir, first);
  const helper = new URL(
    "../ui-smoke/aesthetic-audit-report.ts",
    import.meta.url,
  ).href;
  await promisify(execFile)("bun", [
    "--eval",
    `
    import { writeAuditFinding } from ${JSON.stringify(helper)};
    await writeAuditFinding(${JSON.stringify(outputDir)}, ${JSON.stringify(second)});
  `,
  ]);
  expect(await readAuditFindings(outputDir)).toEqual([first, second]);
});

it("replaces a retried capture while preserving other workers' records", async () => {
  await Promise.all([
    writeAuditFinding(outputDir, {
      slug: "chat",
      viewport: "desktop",
      verdict: "broken",
    }),
    writeAuditFinding(outputDir, {
      slug: "chat",
      viewport: "mobile",
      verdict: "good",
    }),
  ]);
  const retried = { slug: "chat", viewport: "desktop", verdict: "good" };
  await writeAuditFinding(outputDir, retried);
  expect(await readAuditFindings(outputDir)).toEqual([
    retried,
    { slug: "chat", viewport: "mobile", verdict: "good" },
  ]);
});

it("does not import a prior run or an interrupted unpublished write", async () => {
  await writeAuditFinding(outputDir, { slug: "old-view", viewport: "desktop" });
  await rm(outputDir, { recursive: true });
  expect(await readAuditFindings(outputDir)).toEqual([]);
  await writeFile(
    path.join(outputDir, "findings", "interrupted.tmp"),
    "{partial",
  );
  expect(await readAuditFindings(outputDir)).toEqual([]);
  await writeAuditFinding(outputDir, {
    slug: "current-view",
    viewport: "desktop",
  });
  expect(await readAuditFindings(outputDir)).toEqual([
    { slug: "current-view", viewport: "desktop" },
  ]);
});

it("fails on a corrupted published finding instead of silently dropping it", async () => {
  await writeAuditFinding(outputDir, { slug: "chat", viewport: "desktop" });
  const [file] = await readdir(path.join(outputDir, "findings"));
  await writeFile(path.join(outputDir, "findings", file), "{corrupt");
  await expect(readAuditFindings(outputDir)).rejects.toThrow(SyntaxError);
});
