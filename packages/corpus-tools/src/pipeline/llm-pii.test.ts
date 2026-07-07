/**
 * Stage-4 PII sweep coverage for #14771. The deterministic engine is the
 * contract harness for the privacy-filter sidecar: fragment-relative spans,
 * f16-only model configuration, fail-closed mismatch handling, and parity
 * reports across engines.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CorpusMessage } from "../schema.ts";
import { runScrubPipeline } from "./driver.ts";
import {
  applyPiiSweep,
  assertPfCliConfig,
  comparePiiSweepEngines,
  createDeterministicPiiSweepEngine,
  type PiiSweepEngine,
} from "./llm-pii.ts";

const BASE_TS = Date.parse("2026-06-01T12:00:00.000Z");

function message(
  id: string,
  text: string,
  scrubState: CorpusMessage["scrubState"] = "raw",
): CorpusMessage {
  return {
    id,
    platform: "gmail",
    accountId: "work",
    threadId: "thread-llm-pii",
    ts: BASE_TS,
    direction: "in",
    senderId: "sender@example.test",
    senderDisplay: "Sender Example",
    recipients: [
      { id: "owner", display: "Owner", address: "owner@example.test" },
    ],
    subject: "LLM PII",
    text,
    labels: [],
    attachments: [],
    scrubState,
  };
}

function canaryRows(count = 100): CorpusMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(
      `llm-pii-${index}`,
      `Mail the packet by March ${1 + (index % 27)}, 2026 to ${
        100 + index
      } Maple Street. Account number ACCT-${String(index).padStart(
        6,
        "0",
      )} has passcode: blue${index}river.`,
    ),
  );
}

async function writeShard(dir: string, messages: readonly CorpusMessage[]) {
  const shard = path.join(dir, "gmail", "work", "2026-06.jsonl");
  await fs.mkdir(path.dirname(shard), { recursive: true });
  await fs.writeFile(
    shard,
    `${messages.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

describe("pf-cli contract", () => {
  it("enforces the privacy-filter f16 model and rejects q8", () => {
    expect(() =>
      assertPfCliConfig({
        binaryPath: "/usr/local/bin/pf-cli",
        modelPath: "/models/privacy-filter-f16.gguf",
      }),
    ).not.toThrow();
    expect(() =>
      assertPfCliConfig({
        binaryPath: "/usr/local/bin/pf-cli",
        modelPath: "/models/privacy-filter-q8_0.gguf",
      }),
    ).toThrow("f16 model is required");
  });
});

describe("applyPiiSweep", () => {
  it("replaces dates, accounts, addresses, and secret-like prose", async () => {
    const engine = createDeterministicPiiSweepEngine();
    const row = canaryRows(1)[0];

    const result = await applyPiiSweep(row, engine, {
      hashSalt: "llm-pii-v1",
    });

    expect(result.replacements.map((span) => span.kind).sort()).toEqual([
      "account",
      "address",
      "date",
      "secret",
    ]);
    expect(result.message.text).not.toContain("March 1, 2026");
    expect(result.message.text).not.toContain("100 Maple Street");
    expect(result.message.text).not.toContain("ACCT-000000");
    expect(result.message.text).not.toContain("passcode: blue0river");
  });

  it("throws instead of fabricating a clean result when engine spans are invalid", async () => {
    const badEngine: PiiSweepEngine = {
      name: "bad-engine",
      async classify() {
        return [
          {
            kind: "date",
            start: 0,
            end: 4,
            text: "nope",
            confidence: 0.9,
            engine: "bad-engine",
          },
        ];
      },
    };

    await expect(
      applyPiiSweep(message("bad", "March 1, 2026"), badEngine, {
        hashSalt: "llm-pii-v1",
      }),
    ).rejects.toThrow("span mismatch");
  });
});

describe("scrub pipeline llm stage", () => {
  it("runs a 100-message synthetic shard and writes a classification artifact", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-llm-pii-"));
    await writeShard(dir, canaryRows());

    const result = await runScrubPipeline({
      targetPath: dir,
      stage: "all",
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "llm-pii-pipeline-v1",
    });

    const llmReport = result.report.stageReports.find(
      (stage) => stage.stage === "llm",
    );
    expect(llmReport?.piiSpanCount).toBe(400);
    expect(result.report.piiSweepArtifacts?.classificationPath).toBeTruthy();
    const artifactRaw = await fs.readFile(
      result.report.piiSweepArtifacts?.classificationPath ?? "",
      "utf8",
    );
    const artifact = JSON.parse(artifactRaw) as {
      rows: { replacements: Record<string, unknown>[] }[];
    };
    expect(artifact.rows).toHaveLength(100);
    // The on-disk artifact must never carry raw PII cleartext.
    expect(artifactRaw).not.toContain("Maple Street");
    for (const row of artifact.rows) {
      for (const replacement of row.replacements) {
        expect(replacement).not.toHaveProperty("text");
        expect(replacement).toHaveProperty("valueHash");
        expect(replacement).toHaveProperty("replacement");
      }
    }
    expect(
      result.messages.every(
        (row) =>
          !row.text.includes("Maple Street") &&
          !row.text.includes("Account number") &&
          !row.text.includes("passcode:"),
      ),
    ).toBe(true);
  });

  it("generates an engine parity report", async () => {
    const rows = canaryRows(3);
    const baseline = createDeterministicPiiSweepEngine("pf-cli-contract");
    const candidate = createDeterministicPiiSweepEngine("cerebras-contract");

    const report = await comparePiiSweepEngines(rows, baseline, candidate);

    expect(report.messageCount).toBe(3);
    expect(report.baselineSpanCount).toBe(12);
    expect(report.candidateSpanCount).toBe(12);
    expect(report.matchedSpanCount).toBe(12);
    expect(report.missingFromCandidate).toHaveLength(0);
    expect(report.extraInCandidate).toHaveLength(0);
  });
});
