/**
 * Stage-3 gray-area rewrite coverage for #14770. The deterministic harness
 * proves the contract the model-backed path must preserve: consistent fictional
 * replacements across a thread, no source-value reintroduction, and explicit
 * fast-track skip accounting.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CorpusMessage } from "../schema.ts";
import { runScrubPipeline } from "./driver.ts";
import { buildRewritePlan, rewriteSameThemes } from "./rewrite.ts";

const BASE_TS = Date.parse("2026-06-01T12:00:00.000Z");

function message(
  id: string,
  text: string,
  labels: string[] = [],
): CorpusMessage {
  return {
    id,
    platform: "gmail",
    accountId: "work",
    threadId: "thread-gray-rewrite",
    ts: BASE_TS,
    direction: "in",
    senderId: "sender@example.test",
    senderDisplay: "Sender Example",
    recipients: [
      { id: "owner", display: "Owner", address: "owner@example.test" },
    ],
    subject: "Gray rewrite",
    text,
    labels,
    attachments: [],
    scrubState: "raw",
  };
}

async function writeShard(dir: string, messages: readonly CorpusMessage[]) {
  const shard = path.join(dir, "gmail", "work", "2026-06.jsonl");
  await fs.mkdir(path.dirname(shard), { recursive: true });
  await fs.writeFile(
    shard,
    `${messages.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function threadRows(): CorpusMessage[] {
  return Array.from({ length: 10 }, (_, index) =>
    message(
      `gray-${index}`,
      `Acme Corp update ${index}: Project Atlas prep in Portland is still tied to the Launch Gala plan.`,
    ),
  );
}

describe("rewriteSameThemes", () => {
  it("keeps fictional replacements consistent across a synthetic thread", () => {
    const rows = threadRows();
    const plan = buildRewritePlan(rows, { hashSalt: "rewrite-v1" });

    const rewritten = rows.map((row) => rewriteSameThemes(row, plan).message);

    const acmeReplacement = plan.surrogates.find(
      (surrogate) => surrogate.source === "Acme Corp",
    )?.replacement;
    const projectReplacement = plan.surrogates.find(
      (surrogate) => surrogate.source === "Project Atlas",
    )?.replacement;
    expect(acmeReplacement).toBeTruthy();
    expect(projectReplacement).toBeTruthy();
    expect(rewritten.every((row) => !row.text.includes("Acme Corp"))).toBe(
      true,
    );
    expect(rewritten.every((row) => !row.text.includes("Project Atlas"))).toBe(
      true,
    );
    expect(
      rewritten.every((row) => row.text.includes(acmeReplacement ?? "")),
    ).toBe(true);
    expect(
      rewritten.every((row) => row.text.includes(projectReplacement ?? "")),
    ).toBe(true);
  });
});

describe("scrub pipeline rewrite stage", () => {
  it("deep mode rewrites gray-area specifics without reintroducing source values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-rewrite-"));
    await writeShard(dir, threadRows());

    const result = await runScrubPipeline({
      targetPath: dir,
      stage: "all",
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "rewrite-pipeline-v1",
    });

    const rewriteReport = result.report.stageReports.find(
      (stage) => stage.stage === "rewrite",
    );
    expect(rewriteReport?.rewriteReplacementCount).toBe(40);
    for (const row of result.messages) {
      expect(row.text).not.toContain("Acme Corp");
      expect(row.text).not.toContain("Project Atlas");
      expect(row.text).not.toContain("Portland");
      expect(row.text).not.toContain("Launch Gala");
    }
  });

  it("fast-track mode skips gray rewrite and reports the skip explicitly", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "corpus-rewrite-fast-"),
    );
    await writeShard(dir, [
      message(
        "newsletter-1",
        "Acme Corp newsletter: Project Atlas in Portland.",
        ["newsletter"],
      ),
    ]);

    const result = await runScrubPipeline({
      targetPath: dir,
      stage: "all",
      mode: "fast-track",
      resume: true,
      dryRun: false,
      rulesetVersion: "rewrite-fast-v1",
    });

    const rewriteReport = result.report.stageReports.find(
      (stage) => stage.stage === "rewrite",
    );
    expect(rewriteReport?.rewriteSkipped).toBe(1);
    expect(result.messages[0].text).toContain("Acme Corp");
  });
});
