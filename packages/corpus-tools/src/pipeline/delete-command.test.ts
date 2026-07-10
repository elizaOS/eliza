/**
 * End-to-end filesystem coverage for reviewed deletion planning and apply.
 * Synthetic shards exercise the same queue, ledger, corpus, manifest, and
 * approval artifacts used by the CLI without replacing any boundary with mocks.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorpusMessage } from "../schema.ts";
import { readCorpusShard } from "../validator.ts";
import { canonicalDeletionArtifactSha256 } from "./delete.ts";
import { applyDeletionFiles, planDeletionFiles } from "./delete-command.ts";

const temporaryDirectories: string[] = [];
const REVIEWED_AT = "2026-07-10T05:00:00.000Z";
const RULESET = "delete-test-v1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ledgerRecord(
  input: CorpusMessage,
  output: CorpusMessage,
  stage: "mine" | "secrets",
): Record<string, unknown> {
  const inputHash = sha256(JSON.stringify(input));
  return {
    markerKey: `pii:${inputHash}:v${RULESET}:${stage}:test-v1`,
    messageId: input.id,
    stage,
    stageVersion: "test-v1",
    rulesetVersion: RULESET,
    inputHash,
    outputHash: sha256(JSON.stringify(output)),
    tombstone: false,
    output,
  };
}

function message(
  id: string,
  overrides: Partial<CorpusMessage> = {},
): CorpusMessage {
  return {
    id,
    platform: "gmail",
    accountId: "work",
    threadId: `thread-${id}`,
    ts: Date.parse("2026-06-01T12:00:00.000Z"),
    direction: "in",
    senderId: `sender-${id}`,
    senderDisplay: `Sender ${id}`,
    recipients: [{ id: "owner" }],
    text: `Synthetic content for ${id}.`,
    labels: [],
    attachments: [],
    scrubState: "swapped",
    ...overrides,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("reviewed deletion file orchestration", () => {
  it("plans, applies, and resumes an exact owner-reviewed deletion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-delete-"));
    temporaryDirectories.push(root);
    const corpusPath = path.join(root, "corpus");
    const shardPath = path.join(corpusPath, "gmail", "work", "2026-06.jsonl");
    const artifactsPath = path.join(root, "artifacts");
    const sourceMessages = [
      message("delete-me", { labels: ["Delete"] }),
      message("keep-me", {
        attachments: [
          {
            filename: "synthetic.txt",
            mimeType: "text/plain",
            sha256: "a".repeat(64),
            bytes: 9,
            dataBase64: "c3ludGhldGlj",
          },
        ],
      }),
    ];
    await fs.mkdir(path.dirname(shardPath), { recursive: true });
    await fs.writeFile(
      shardPath,
      `${sourceMessages.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const candidatesPath = path.join(artifactsPath, "candidates.jsonl");
    await fs.mkdir(artifactsPath, { recursive: true });
    await fs.writeFile(candidatesPath, "");
    const rulesPath = path.join(artifactsPath, "rules.yaml");
    await fs.writeFile(
      rulesPath,
      `schemaVersion: 1
rulesetVersion: delete-test-v1
attachmentPolicy:
  embeddedBytes: drop
  retainMetadata: [filename, mimeType, sha256]
rules:
  - id: delete-label
    enabled: true
    scope: message
    match:
      type: label
      value: Delete
`,
    );
    const queuePath = path.join(artifactsPath, "queue.json");
    const normalizedRulesPath = path.join(artifactsPath, "rules.json");
    const ledgerPath = path.join(artifactsPath, "ledger.jsonl");
    const upstreamRecords = sourceMessages.flatMap((swapped) => {
      const raw = { ...swapped, scrubState: "raw" } as CorpusMessage;
      const mined = { ...swapped, scrubState: "mined" } as CorpusMessage;
      return [
        ledgerRecord(raw, mined, "mine"),
        ledgerRecord(mined, swapped, "secrets"),
      ];
    });
    await fs.writeFile(
      ledgerPath,
      `${upstreamRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const queue = await planDeletionFiles({
      targetPath: corpusPath,
      candidatesPath,
      rulesPath,
      queuePath,
      normalizedRulesPath,
    });

    expect(queue.groups).toHaveLength(1);
    expect(queue.groups[0]?.messageIds).toEqual(["delete-me"]);
    expect(
      [...(queue.groups[0]?.redactedContext ?? "")].length,
    ).toBeLessThanOrEqual(60);

    const decisionsPath = path.join(artifactsPath, "decisions.json");
    await writeJson(decisionsPath, {
      schemaVersion: 1,
      rulesetVersion: queue.rulesetVersion,
      corpusDigest: queue.corpusDigest,
      rulesSha256: queue.rulesSha256,
      reviewedQueueSha256: canonicalDeletionArtifactSha256(queue),
      approved: true,
      reviewedBy: "synthetic-owner",
      reviewedAt: REVIEWED_AT,
      decisions: queue.groups.map((group) => ({
        groupId: group.groupId,
        decision: "delete",
      })),
    });
    const applyOptions = {
      targetPath: corpusPath,
      candidatesPath,
      normalizedRulesPath,
      queuePath,
      decisionsPath,
      outputPath: path.join(root, "survivors"),
      ledgerPath,
      manifestPath: path.join(artifactsPath, "manifest.json"),
      approvalPath: path.join(artifactsPath, "approval.json"),
      reportPath: path.join(artifactsPath, "report.json"),
    };

    const originalQueue = JSON.parse(
      await fs.readFile(queuePath, "utf8"),
    ) as Record<string, unknown>;
    const tamperedGroups = structuredClone(
      originalQueue.groups as Record<string, unknown>[],
    );
    tamperedGroups[0].redactedContext = "misleading review context";
    await writeJson(queuePath, { ...originalQueue, groups: tamperedGroups });
    await expect(applyDeletionFiles(applyOptions)).rejects.toThrow(
      "deletion review queue is not canonical for its inputs",
    );
    await writeJson(queuePath, originalQueue);

    const originalLedger = await fs.readFile(ledgerPath, "utf8");
    const mismatchedRecords = structuredClone(upstreamRecords);
    const secretsRecord = mismatchedRecords.find(
      (record) => record.stage === "secrets",
    );
    if (!secretsRecord?.output) {
      throw new Error("fixture is missing a secrets record");
    }
    secretsRecord.output = {
      ...(secretsRecord.output as CorpusMessage),
      text: "Different swapped corpus.",
    };
    secretsRecord.outputHash = sha256(JSON.stringify(secretsRecord.output));
    await fs.writeFile(
      ledgerPath,
      `${mismatchedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await expect(applyDeletionFiles(applyOptions)).rejects.toThrow(
      "deletion target is not the secrets output",
    );
    await fs.writeFile(ledgerPath, originalLedger);

    await fs.writeFile(`${ledgerPath}.lock`, "held", { mode: 0o600 });
    await expect(applyDeletionFiles(applyOptions)).rejects.toMatchObject({
      code: "EEXIST",
    });
    await fs.rm(`${ledgerPath}.lock`);

    const first = await applyDeletionFiles(applyOptions);
    const second = await applyDeletionFiles(applyOptions);

    expect(first.ledgerRecordsWritten).toBe(2);
    expect(second.ledgerRecordsWritten).toBe(0);
    expect(first.approval).toEqual(second.approval);
    expect(first.approval).toMatchObject({
      survivorCount: 1,
      tombstoneCount: 1,
      attachmentBytesDropped: 1,
    });
    const outputShard = await readCorpusShard(
      path.join(applyOptions.outputPath, "gmail", "work", "2026-06.jsonl"),
      { rootDir: applyOptions.outputPath },
    );
    expect(outputShard.issues).toEqual([]);
    expect(outputShard.messages).toHaveLength(1);
    expect(outputShard.messages[0]?.id).toBe("keep-me");
    expect(outputShard.messages[0]?.attachments[0]).toEqual({
      filename: "synthetic.txt",
      mimeType: "text/plain",
      sha256: "a".repeat(64),
    });
    const ledger = (await fs.readFile(applyOptions.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ledger).toHaveLength(6);
    const deletionRecords = ledger.filter(
      (record) => record.stage === "delete",
    );
    expect(deletionRecords).toHaveLength(2);
    for (const record of deletionRecords) {
      expect(record).toMatchObject({
        stageVersion: first.approval.deleteStageVersion,
        rulesSha256: first.approval.rulesSha256,
        reviewedQueueSha256: first.approval.reviewedQueueSha256,
        reviewDecisionSha256: first.approval.reviewDecisionSha256,
      });
    }
    const tombstone = deletionRecords.find(
      (record) => record.tombstone === true,
    );
    expect(tombstone).toBeDefined();
    expect(tombstone).not.toHaveProperty("output");
    expect(JSON.stringify(tombstone)).not.toContain("Synthetic content");
    expect(
      JSON.parse(await fs.readFile(applyOptions.approvalPath, "utf8")),
    ).toEqual(first.approval);
    expect(
      JSON.parse(await fs.readFile(applyOptions.reportPath, "utf8")),
    ).toEqual(first.report);
    await expect(
      applyDeletionFiles({
        ...applyOptions,
        outputPath: path.join(corpusPath, "nested-output"),
      }),
    ).rejects.toThrow("deletion input and output paths must not overlap");
    const ledgerMode = (await fs.stat(ledgerPath)).mode & 0o777;
    const queueMode = (await fs.stat(queuePath)).mode & 0o777;
    expect(ledgerMode).toBe(0o600);
    expect(queueMode).toBe(0o600);

    await fs.appendFile(ledgerPath, `${JSON.stringify(deletionRecords[0])}\n`);
    await expect(applyDeletionFiles(applyOptions)).rejects.toThrow(
      "deletion ledger contains duplicate marker history",
    );
  });
});
