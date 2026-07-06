/**
 * Scrub-driver tests for #14764. The stages are deterministic stand-ins for
 * downstream PII detectors and rewriters so the tests can prove orchestration:
 * marker idempotency, crash resume, fast-track clustering, and cost reporting.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CorpusMessage, ScrubState } from "../schema.ts";
import {
  runScrubPipeline,
  type ScrubStageDefinition,
  type ScrubStageName,
} from "./driver.ts";

const BASE_TS = Date.parse("2026-06-01T12:00:00.000Z");

function hashMessages(messages: readonly CorpusMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function message(
  id: string,
  text: string,
  labels: string[] = [],
): CorpusMessage {
  return {
    id,
    platform: "gmail",
    accountId: "work",
    threadId: `thread-${id}`,
    ts: BASE_TS,
    direction: "in",
    senderId: "newsletter@example.test",
    senderDisplay: "Newsletter Example",
    recipients: [
      { id: "owner", display: "Owner", address: "owner@example.test" },
    ],
    subject: "Weekly digest",
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
  return shard;
}

function targetState(stage: ScrubStageName): ScrubState {
  switch (stage) {
    case "mine":
      return "mined";
    case "secrets":
    case "delete":
      return "swapped";
    case "rewrite":
    case "llm":
      return "rewritten";
    case "verify":
      return "verified";
  }
}

function deterministicStages(): ScrubStageDefinition[] {
  const stageNames: ScrubStageName[] = [
    "mine",
    "secrets",
    "delete",
    "rewrite",
    "llm",
    "verify",
  ];
  return stageNames.map((stageName) => ({
    name: stageName,
    version: "test-v1",
    targetState: targetState(stageName),
    run(message, context) {
      const next: CorpusMessage = {
        ...message,
        text:
          stageName === "rewrite"
            ? message.text.replaceAll("Alice", "Person A")
            : message.text,
        scrubState: targetState(stageName),
      };
      return {
        message: next,
        cost:
          stageName === "llm" &&
          (context.mode === "deep" || context.isClusterExemplar)
            ? {
                inputTokens: 100,
                outputTokens: 20,
                estimatedUsd: 0.01,
                llmCalls: 1,
              }
            : {
                inputTokens: 0,
                outputTokens: 0,
                estimatedUsd: 0,
                llmCalls: 0,
              },
      };
    },
  }));
}

describe("scrub pipeline driver", () => {
  it("resumes after interruption to the same final output hash", async () => {
    const uninterruptedDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "corpus-scrub-uninterrupted-"),
    );
    const resumedDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "corpus-scrub-resumed-"),
    );
    const rows = [
      message("msg-1", "Alice can review the packet."),
      message("msg-2", "Alice will send notes tomorrow."),
      message("msg-3", "No personal name here."),
    ];
    await writeShard(uninterruptedDir, rows);
    await writeShard(resumedDir, rows);

    const uninterrupted = await runScrubPipeline({
      targetPath: uninterruptedDir,
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "resume-test",
      stages: deterministicStages(),
    });

    await expect(
      runScrubPipeline({
        targetPath: resumedDir,
        mode: "deep",
        resume: true,
        dryRun: false,
        rulesetVersion: "resume-test",
        stages: deterministicStages(),
        maxStageExecutions: 5,
      }),
    ).rejects.toThrow("simulated interruption");

    const resumed = await runScrubPipeline({
      targetPath: resumedDir,
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "resume-test",
      stages: deterministicStages(),
    });

    expect(hashMessages(resumed.messages)).toBe(
      hashMessages(uninterrupted.messages),
    );
    expect(resumed.report.ledger.hitRate).toBeGreaterThan(0);
    expect(resumed.messages.every((row) => row.scrubState === "verified")).toBe(
      true,
    );
  });

  it("reruns unchanged input as 100% ledger hits", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-scrub-rerun-"));
    await writeShard(dir, [
      message("msg-1", "Alice can review the packet."),
      message("msg-2", "Alice can review the packet again."),
    ]);

    await runScrubPipeline({
      targetPath: dir,
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "rerun-test",
      stages: deterministicStages(),
    });
    const rerun = await runScrubPipeline({
      targetPath: dir,
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "rerun-test",
      stages: deterministicStages(),
    });

    expect(rerun.report.ledger.recordsWritten).toBe(0);
    expect(rerun.report.ledger.hitRate).toBe(1);
    expect(
      rerun.report.stageReports.every((stage) => stage.executed === 0),
    ).toBe(true);
  });

  it("fast-track reduces newsletter LLM calls by at least 10x", async () => {
    const deepDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "corpus-scrub-deep-"),
    );
    const fastDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "corpus-scrub-fast-"),
    );
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      message(
        `newsletter-${index}`,
        `Weekly digest issue ${index}: Alice can review item ${index}. Visit https://example.test/${index}.`,
        ["newsletter"],
      ),
    );
    await writeShard(deepDir, rows);
    await writeShard(fastDir, rows);

    const deep = await runScrubPipeline({
      targetPath: deepDir,
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "fast-track-test",
      stages: deterministicStages(),
    });
    const fast = await runScrubPipeline({
      targetPath: fastDir,
      mode: "fast-track",
      resume: true,
      dryRun: false,
      rulesetVersion: "fast-track-test",
      stages: deterministicStages(),
    });

    const deepLlmCalls = deep.report.stageReports.find(
      (stage) => stage.stage === "llm",
    )?.llmCalls;
    const fastLlmCalls = fast.report.stageReports.find(
      (stage) => stage.stage === "llm",
    )?.llmCalls;
    expect(deepLlmCalls).toBe(1_000);
    expect(fastLlmCalls).toBeLessThanOrEqual(100);
    expect(fast.report.clusterStats.largestCluster).toBe(1_000);
    expect(fast.report.stageReports).toContainEqual(
      expect.objectContaining({
        stage: "llm",
        inputTokens: fastLlmCalls === undefined ? 0 : fastLlmCalls * 100,
      }),
    );
  });
});
