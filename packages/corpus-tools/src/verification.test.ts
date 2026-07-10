/**
 * Adversarial coverage for the corpus-wide privacy gate: exact-byte freshness,
 * detector failures, canary and placeholder provenance, and report sanitizing.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorpusMessage } from "./schema.ts";
import { buildCorpusManifest } from "./validator.ts";
import {
  assertFreshGreenVerification,
  scanShardsWithGitleaks,
  type VerifyCorpusOptions,
  verifyCorpus,
} from "./verification.ts";

const RULESET = "verification-test-v1";
const GENERATED_AT = "2026-07-09T00:00:00.000Z";
const DEFAULT_CANDIDATE = "Original Sender";
const temporaryDirectories: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function defaultCanaryPlaceholder(): string {
  return `[[PII:person:${sha256(`${RULESET}\0${DEFAULT_CANDIDATE}`).slice(0, 12)}]]`;
}

function ledgerRecord(
  input: CorpusMessage,
  output: CorpusMessage,
  stage: string,
  stageVersion = "test-v1",
): Record<string, unknown> {
  const inputHash = sha256(JSON.stringify(input));
  return {
    markerKey: [`pii:${inputHash}:v${RULESET}`, stage, stageVersion].join(":"),
    messageId: input.id,
    stage,
    stageVersion,
    rulesetVersion: RULESET,
    inputHash,
    outputHash: sha256(JSON.stringify(output)),
    tombstone: false,
    output,
  };
}

function baseMessage(overrides: Partial<CorpusMessage> = {}): CorpusMessage {
  return {
    id: "message-1",
    platform: "gmail",
    accountId: "work",
    threadId: "thread-1",
    ts: Date.parse("2026-06-01T12:00:00.000Z"),
    direction: "in",
    senderId: "sender-1",
    senderDisplay: "Sender One",
    recipients: [{ id: "recipient-1", display: "Recipient One" }],
    text: "Scrubbed body.",
    labels: [],
    attachments: [],
    scrubState: "rewritten",
    ...overrides,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fakeGitleaks(
  root: string,
  reportMode: "missing" | "empty",
): Promise<string> {
  const binaryPath = path.join(root, `gitleaks-${reportMode}`);
  const reportWrite =
    reportMode === "empty"
      ? 'while [ "$#" -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf "[]" > "$1"; fi; shift; done\n'
      : "";
  await fs.writeFile(
    binaryPath,
    `#!/bin/sh\nif [ "$1" = "version" ]; then echo 8.30.1; exit 0; fi\n${reportWrite}exit 1\n`,
    { mode: 0o700 },
  );
  return binaryPath;
}

async function fixture(
  message: CorpusMessage,
  options: { candidate?: string; canaryPlaceholder?: string } = {},
): Promise<VerifyCorpusOptions> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-verify-test-"));
  temporaryDirectories.push(root);
  const corpusDir = path.join(root, "corpus");
  const artifactDir = path.join(root, "artifacts");
  const shardPath = path.join(corpusDir, "gmail", "work", "2026-06.jsonl");
  await fs.mkdir(path.dirname(shardPath), { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(shardPath, `${JSON.stringify(message)}\n`);

  const { manifest, issues } = await buildCorpusManifest(
    corpusDir,
    GENERATED_AT,
  );
  expect(issues).toEqual([]);
  const manifestPath = path.join(artifactDir, "manifest.json");
  await writeJson(manifestPath, manifest);

  const candidate = options.candidate ?? DEFAULT_CANDIDATE;
  const candidateKind = candidate.includes("@") ? "email" : "person";
  const candidateHash = sha256(`${RULESET}\0${candidate}`);
  const mineText = `Source ${candidate}`;
  const candidateStart = mineText.indexOf(candidate);
  const candidatesPath = path.join(artifactDir, "candidates.jsonl");
  await fs.writeFile(
    candidatesPath,
    `${JSON.stringify({
      msgId: message.id,
      kind: candidateKind,
      sourceRef: {
        tableName: "corpus_messages",
        memoryId: message.id,
        threadId: message.threadId,
        platform: message.platform,
        accountId: message.accountId,
        field: "text",
        span: { start: candidateStart, end: candidateStart + candidate.length },
      },
      surfaceForm: candidate,
      valueHash: candidateHash,
    })}\n`,
  );

  const canaryPlaceholder =
    options.canaryPlaceholder ??
    message.text.match(/\[\[SECRET:[^\]]+\]\]/)?.[0] ??
    defaultCanaryPlaceholder();
  const canariesPath = path.join(artifactDir, "canaries.json");
  await writeJson(canariesPath, {
    schemaVersion: 1,
    rulesetVersion: RULESET,
    canaries: [
      {
        id: "canary-1",
        messageId: message.id,
        expected: { outcome: "placeholder", value: canaryPlaceholder },
      },
    ],
  });

  const raw = {
    ...message,
    text: mineText,
    senderDisplay:
      options.candidate === undefined ? candidate : message.senderDisplay,
    scrubState: "raw",
  } as CorpusMessage;
  const mined = {
    ...message,
    text: mineText,
    senderDisplay:
      options.candidate === undefined ? candidate : message.senderDisplay,
    scrubState: "mined",
  } as CorpusMessage;
  const swapped = { ...message, scrubState: "swapped" } as CorpusMessage;
  const deleted = {
    ...swapped,
    attachments: swapped.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
    })),
  } as CorpusMessage;
  const rewritten = { ...message, scrubState: "rewritten" } as CorpusMessage;
  const ledgerRecords = [
    ledgerRecord(raw, mined, "mine"),
    ledgerRecord(mined, swapped, "secrets"),
    ledgerRecord(swapped, deleted, "delete", "delete-v1"),
    ledgerRecord(deleted, rewritten, "rewrite"),
    ledgerRecord(rewritten, rewritten, "llm"),
  ];
  const ledgerPath = path.join(artifactDir, "scrub-ledger.jsonl");
  await fs.writeFile(
    ledgerPath,
    `${ledgerRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const gazetteerPath = path.join(artifactDir, "gazetteer.json");
  await writeJson(gazetteerPath, [
    { kind: "person", value: "original-owner-name" },
  ]);
  const deletionRulesPath = path.join(artifactDir, "delete-rules.json");
  const deletionReviewQueuePath = path.join(
    artifactDir,
    "deletion-review-queue.json",
  );
  const deletionReviewDecisionPath = path.join(
    artifactDir,
    "deletion-review-decision.json",
  );
  const deletionRules = {
    schemaVersion: 1,
    rulesetVersion: RULESET,
    attachmentPolicy: {
      embeddedBytes: "drop",
      retainMetadata: ["filename", "mimeType", "sha256"],
    },
    rules: [],
  };
  const rulesSha256 = sha256(canonicalJson(deletionRules));
  const deletionCandidatesSha256 = sha256(
    canonicalJson([{ msgId: message.id, kind: candidateKind }]),
  );
  const deletionQueue = {
    schemaVersion: 1,
    rulesetVersion: RULESET,
    corpusDigest: "pending",
    rulesSha256,
    candidatesSha256: deletionCandidatesSha256,
    groups: [],
  };
  await writeJson(deletionRulesPath, deletionRules);
  const corpusDigest = sha256(canonicalJson([swapped]));
  deletionQueue.corpusDigest = corpusDigest;
  await writeJson(deletionReviewQueuePath, deletionQueue);
  const reviewedQueueSha256 = sha256(canonicalJson(deletionQueue));
  const deletionDecision = {
    schemaVersion: 1,
    rulesetVersion: RULESET,
    corpusDigest,
    rulesSha256,
    reviewedQueueSha256,
    approved: true,
    reviewedBy: "test-owner",
    reviewedAt: GENERATED_AT,
    decisions: [],
  };
  await writeJson(deletionReviewDecisionPath, deletionDecision);
  const reviewDecisionSha256 = sha256(canonicalJson(deletionDecision));
  const deleteStageVersion = `delete-v1:${rulesSha256.slice(0, 12)}:${reviewedQueueSha256.slice(0, 12)}:${reviewDecisionSha256.slice(0, 12)}`;
  Object.assign(ledgerRecords[2], {
    stageVersion: deleteStageVersion,
    markerKey: [
      `pii:${ledgerRecords[2].inputHash}:v${RULESET}`,
      "delete",
      deleteStageVersion,
    ].join(":"),
    rulesSha256,
    reviewedQueueSha256,
    reviewDecisionSha256,
  });
  await fs.writeFile(
    ledgerPath,
    `${ledgerRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const deletionApprovalPath = path.join(artifactDir, "deletion-approval.json");
  await writeJson(deletionApprovalPath, {
    schemaVersion: 1,
    rulesetVersion: RULESET,
    corpusDigest,
    candidatesSha256: deletionCandidatesSha256,
    deleteStageVersion,
    approved: true,
    rulesSha256,
    reviewedQueueSha256,
    reviewDecisionSha256,
    tombstoneIdsSha256: sha256(canonicalJson([])),
    tombstoneCount: 0,
    survivorCount: 1,
    attachmentBytesDropped: swapped.attachments.reduce(
      (total, attachment) =>
        total +
        (attachment.dataBase64 !== undefined
          ? Buffer.from(attachment.dataBase64, "base64").length
          : (attachment.bytes ?? 0)),
      0,
    ),
  });
  const placeholderRegistryPath = path.join(
    artifactDir,
    "placeholder-registry.json",
  );
  const registryEntries = [
    ...message.text.matchAll(
      /\[\[(?:SECRET|PII):([a-z0-9-]+):([a-f0-9]{12})\]\]/g,
    ),
  ].map((match) => ({
    placeholder: match[0],
    kind: match[1],
    valueHash:
      match[2] === candidateHash.slice(0, 12)
        ? candidateHash
        : `${match[2]}${"0".repeat(52)}`,
    stage: "secrets",
    messageId: message.id,
  }));
  await writeJson(placeholderRegistryPath, {
    schemaVersion: 1,
    rulesetVersion: RULESET,
    entries: registryEntries,
  });
  const gitleaksConfigPath = path.join(artifactDir, ".gitleaks.toml");
  await fs.writeFile(gitleaksConfigPath, 'title = "test"\n');

  return {
    targetPath: corpusDir,
    manifestPath,
    candidatesPath,
    canariesPath,
    ledgerPath,
    gazetteerPath,
    deletionRulesPath,
    deletionReviewQueuePath,
    deletionReviewDecisionPath,
    deletionApprovalPath,
    placeholderRegistryPath,
    rulesetVersion: RULESET,
    reportPath: path.join(artifactDir, "verification-report.json"),
    gitleaksConfigPath,
    gitleaksScanner: async () => ({ version: "test-gitleaks", findings: [] }),
    now: () => new Date(GENERATED_AT),
  };
}

async function rebindDeletionArtifacts(
  options: VerifyCorpusOptions,
  rules: Record<string, unknown>,
): Promise<void> {
  await writeJson(options.deletionRulesPath, rules);
  const normalizedRules = {
    ...rules,
    rules: [...((rules.rules as Record<string, unknown>[]) ?? [])].sort(
      (left, right) => String(left.id).localeCompare(String(right.id)),
    ),
  };
  const rulesSha256 = sha256(canonicalJson(normalizedRules));
  const ledger = (await fs.readFile(options.ledgerPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const deletionInputs = ledger
    .filter(
      (record) =>
        record.stage === "secrets" && !record.tombstone && record.output,
    )
    .map((record) => record.output as CorpusMessage)
    .sort((left, right) => left.id.localeCompare(right.id));
  const corpusDigest = sha256(canonicalJson(deletionInputs));
  const queue = JSON.parse(
    await fs.readFile(options.deletionReviewQueuePath, "utf8"),
  ) as Record<string, unknown>;
  Object.assign(queue, { corpusDigest, rulesSha256 });
  await writeJson(options.deletionReviewQueuePath, queue);
  const reviewedQueueSha256 = sha256(canonicalJson(queue));
  const decision = JSON.parse(
    await fs.readFile(options.deletionReviewDecisionPath, "utf8"),
  ) as Record<string, unknown>;
  Object.assign(decision, { corpusDigest, rulesSha256, reviewedQueueSha256 });
  await writeJson(options.deletionReviewDecisionPath, decision);
  const reviewDecisionSha256 = sha256(canonicalJson(decision));
  const deleteStageVersion = `delete-v1:${rulesSha256.slice(0, 12)}:${reviewedQueueSha256.slice(0, 12)}:${reviewDecisionSha256.slice(0, 12)}`;
  const approval = JSON.parse(
    await fs.readFile(options.deletionApprovalPath, "utf8"),
  ) as Record<string, unknown>;
  await writeJson(options.deletionApprovalPath, {
    ...approval,
    corpusDigest,
    rulesSha256,
    reviewedQueueSha256,
    reviewDecisionSha256,
    deleteStageVersion,
  });
  for (const record of ledger) {
    if (record.stage !== "delete" || record.tombstone) continue;
    record.stageVersion = deleteStageVersion;
    record.markerKey = [
      `pii:${record.inputHash}:v${RULESET}`,
      "delete",
      deleteStageVersion,
    ].join(":");
    Object.assign(record, {
      rulesSha256,
      reviewedQueueSha256,
      reviewDecisionSha256,
    });
  }
  await fs.writeFile(
    options.ledgerPath,
    `${ledger.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("corpus verification", () => {
  it("binds a green report to exact corpus bytes and rejects tampering", async () => {
    const placeholder = defaultCanaryPlaceholder();
    const options = await fixture(
      baseMessage({ text: `Scrubbed body ${placeholder}` }),
      { canaryPlaceholder: placeholder },
    );
    const report = await verifyCorpus(options);

    expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual(
      [],
    );
    expect(report.status).toBe("passed");
    const deletionApproval = JSON.parse(
      await fs.readFile(options.deletionApprovalPath, "utf8"),
    ) as { corpusDigest: string };
    expect(deletionApproval.corpusDigest).not.toBe(report.corpusDigest);
    await expect(
      assertFreshGreenVerification(report, options),
    ).resolves.toBeUndefined();

    const tampered = { ...report, messageCount: 99 };
    await expect(
      assertFreshGreenVerification(tampered, options),
    ).rejects.toThrow("does not match a fresh verification");

    const shard = path.join(
      options.targetPath,
      "gmail",
      "work",
      "2026-06.jsonl",
    );
    await fs.appendFile(shard, " \n");
    await expect(
      assertFreshGreenVerification(report, options),
    ).rejects.toThrow();
  });

  it.each([
    "manifestPath",
    "ledgerPath",
    "candidatesPath",
    "canariesPath",
    "gazetteerPath",
    "deletionRulesPath",
    "deletionReviewQueuePath",
    "deletionReviewDecisionPath",
    "deletionApprovalPath",
    "placeholderRegistryPath",
    "gitleaksConfigPath",
  ] as const)("rejects a report after %s changes", async (pathKey) => {
    const placeholder = defaultCanaryPlaceholder();
    const options = await fixture(
      baseMessage({ text: `Scrubbed body ${placeholder}` }),
      { canaryPlaceholder: placeholder },
    );
    const report = await verifyCorpus(options);
    const artifactPath = options[pathKey];
    expect(artifactPath).toBeTypeOf("string");
    await fs.appendFile(artifactPath as string, " ");

    await expect(
      assertFreshGreenVerification(report, options),
    ).rejects.toThrow();
  });

  it("cannot turn a failed report green by recomputing its plain digest", async () => {
    const leaked = "owner-private@example.com";
    const options = await fixture(baseMessage({ text: leaked }), {
      candidate: leaked,
    });
    const failed = await verifyCorpus(options);
    const zeroCounts: typeof failed.counts = {
      "attachment-policy": 0,
      canary: 0,
      entity: 0,
      gitleaks: 0,
      ledger: 0,
      "original-value": 0,
      placeholder: 0,
      "redact-pattern": 0,
      "structured-pii": 0,
    };
    const forgedUnsigned = {
      ...failed,
      status: "passed" as const,
      findings: [],
      scanner: { ...failed.scanner, findingCount: 0 },
      counts: zeroCounts,
    };
    const { reportDigest: _oldDigest, ...unsigned } = forgedUnsigned;
    const forged = {
      ...unsigned,
      reportDigest: sha256(canonicalJson(unsigned)),
    };

    await expect(assertFreshGreenVerification(forged, options)).rejects.toThrow(
      "fresh verification is not green",
    );
  });

  it("rejects a candidate whose claimed value hash is forged", async () => {
    const options = await fixture(baseMessage());
    const line = JSON.parse(
      (await fs.readFile(options.candidatesPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    line.valueHash = "0".repeat(64);
    await fs.writeFile(options.candidatesPath, `${JSON.stringify(line)}\n`);

    await expect(verifyCorpus(options)).rejects.toThrow(
      "candidate value hash is invalid",
    );
  });

  it("rejects an incomplete mine candidate artifact", async () => {
    const leaked = "owner-private@example.com";
    const options = await fixture(baseMessage({ text: leaked }), {
      candidate: leaked,
    });
    const line = JSON.parse(
      (await fs.readFile(options.candidatesPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    line.kind = "original";
    await fs.writeFile(options.candidatesPath, `${JSON.stringify(line)}\n`);

    await expect(verifyCorpus(options)).rejects.toThrow(
      "mine candidate artifact does not exactly match mining rerun",
    );
  });

  it("rejects extra or duplicate mine candidates", async () => {
    const options = await fixture(baseMessage());
    const row = (await fs.readFile(options.candidatesPath, "utf8")).trim();
    await fs.writeFile(options.candidatesPath, `${row}\n${row}\n`);

    await expect(verifyCorpus(options)).rejects.toThrow(
      "mine candidate artifact does not exactly match mining rerun",
    );
  });

  it("rejects an ambiguous mine source instead of last-write-wins", async () => {
    const options = await fixture(baseMessage());
    const records = (await fs.readFile(options.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const mine = records.find((record) => record.stage === "mine");
    if (!mine) throw new Error("fixture ledger has no mine record");
    await fs.appendFile(options.ledgerPath, `${JSON.stringify(mine)}\n`);

    await expect(verifyCorpus(options)).rejects.toThrow(
      "ambiguous mine ledger history",
    );
  });

  it("rejects a mine row without an exact secrets successor", async () => {
    const options = await fixture(baseMessage());
    const orphanInput = baseMessage({
      id: "orphan-mine",
      threadId: "orphan-thread",
      scrubState: "raw",
    });
    const orphanOutput = {
      ...orphanInput,
      scrubState: "mined",
    } as CorpusMessage;
    await fs.appendFile(
      options.ledgerPath,
      `${JSON.stringify(ledgerRecord(orphanInput, orphanOutput, "mine"))}\n`,
    );

    await expect(verifyCorpus(options)).rejects.toThrow(
      "mine and secrets ledger stages do not match exactly",
    );
  });

  it("canonicalizes deletion rule order when validating provenance", async () => {
    const placeholder = defaultCanaryPlaceholder();
    const options = await fixture(baseMessage({ text: placeholder }), {
      canaryPlaceholder: placeholder,
    });
    const rules = JSON.parse(
      await fs.readFile(options.deletionRulesPath, "utf8"),
    ) as Record<string, unknown>;
    rules.rules = [
      {
        id: "z-disabled",
        enabled: false,
        scope: "message",
        match: { type: "label", value: "Z" },
      },
      {
        id: "a-disabled",
        enabled: false,
        scope: "message",
        match: { type: "label", value: "A" },
      },
    ];
    await rebindDeletionArtifacts(options, rules);

    const report = await verifyCorpus(options);

    expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual(
      [],
    );
    expect(report.status).toBe("passed");
  });

  it("matches token-mode keyword phrases at word boundaries", async () => {
    const options = await fixture(baseMessage());
    const rules = {
      schemaVersion: 1,
      rulesetVersion: RULESET,
      attachmentPolicy: {
        embeddedBytes: "drop",
        retainMetadata: ["filename", "mimeType", "sha256"],
      },
      rules: [
        {
          id: "phrase-match",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "scrubbed body",
            mode: "token",
            fields: ["text"],
          },
        },
      ],
    };
    const ruleIdHashes = [sha256("phrase-match")];
    const groupId = sha256(
      canonicalJson({
        scope: "message",
        platform: "gmail",
        messageIds: ["message-1"],
        ruleIdHashes,
      }),
    );
    const queue = JSON.parse(
      await fs.readFile(options.deletionReviewQueuePath, "utf8"),
    ) as Record<string, unknown>;
    queue.groups = [
      {
        groupId,
        scope: "message",
        platform: "gmail",
        messageIds: ["message-1"],
        ruleIdHashes,
        matchClasses: ["keyword"],
        redactedContext: "[MATCH].",
        suggestedDecision: "delete",
      },
    ];
    await writeJson(options.deletionReviewQueuePath, queue);
    const decision = JSON.parse(
      await fs.readFile(options.deletionReviewDecisionPath, "utf8"),
    ) as Record<string, unknown>;
    decision.decisions = [{ groupId, decision: "keep" }];
    await writeJson(options.deletionReviewDecisionPath, decision);
    await rebindDeletionArtifacts(options, rules);

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toEqual([
      expect.objectContaining({ detector: "canary-placeholder" }),
    ]);
  });

  it("rejects a forged delete-stage version", async () => {
    const options = await fixture(baseMessage());
    const approval = JSON.parse(
      await fs.readFile(options.deletionApprovalPath, "utf8"),
    ) as Record<string, unknown>;
    approval.deleteStageVersion = "delete-v1:forged";
    await writeJson(options.deletionApprovalPath, approval);

    await expect(verifyCorpus(options)).rejects.toThrow(
      "deletion approval delete stage version is invalid",
    );
  });

  it("rejects a pre-delete message omitted from both survivors and tombstones", async () => {
    const options = await fixture(baseMessage());
    const orphan = baseMessage({
      id: "message-orphan",
      threadId: "thread-orphan",
      scrubState: "swapped",
    });
    const orphanInput = { ...orphan, scrubState: "mined" } as CorpusMessage;
    const orphanRaw = { ...orphan, scrubState: "raw" } as CorpusMessage;
    await fs.appendFile(
      options.ledgerPath,
      `${JSON.stringify(ledgerRecord(orphanRaw, orphanInput, "mine"))}\n${JSON.stringify(ledgerRecord(orphanInput, orphan, "secrets"))}\n`,
    );
    const rules = JSON.parse(
      await fs.readFile(options.deletionRulesPath, "utf8"),
    ) as Record<string, unknown>;
    await rebindDeletionArtifacts(options, rules);

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "deletion-input-partition" }),
    );
  });

  it("rejects a deletion approval with the wrong survivor count", async () => {
    const options = await fixture(baseMessage());
    const approval = JSON.parse(
      await fs.readFile(options.deletionApprovalPath, "utf8"),
    ) as Record<string, unknown>;
    approval.survivorCount = 2;
    await writeJson(options.deletionApprovalPath, approval);

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "deletion-survivor-count" }),
    );
  });

  it("rejects a deletion approval with the wrong attachment drop count", async () => {
    const options = await fixture(baseMessage());
    const approval = JSON.parse(
      await fs.readFile(options.deletionApprovalPath, "utf8"),
    ) as Record<string, unknown>;
    approval.attachmentBytesDropped = 1;
    await writeJson(options.deletionApprovalPath, approval);

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "deletion-attachment-drop-count" }),
    );
  });

  it("rejects deletion provenance that is not bound to the supplied bytes", async () => {
    const options = await fixture(baseMessage());
    const rules = JSON.parse(
      await fs.readFile(options.deletionRulesPath, "utf8"),
    ) as { rules: unknown[] };
    rules.rules.push({ id: "unreviewed" });
    await writeJson(options.deletionRulesPath, rules);

    await expect(verifyCorpus(options)).rejects.toThrow();
  });

  it("rejects a deletion queue that omits a rule match", async () => {
    const options = await fixture(baseMessage({ labels: ["Delete"] }));
    const rules = JSON.parse(
      await fs.readFile(options.deletionRulesPath, "utf8"),
    ) as Record<string, unknown>;
    rules.rules = [
      {
        id: "delete-label",
        enabled: true,
        scope: "message",
        match: { type: "label", value: "Delete" },
      },
    ];
    await writeJson(options.deletionRulesPath, rules);
    const rulesSha256 = sha256(canonicalJson(rules));
    const queue = JSON.parse(
      await fs.readFile(options.deletionReviewQueuePath, "utf8"),
    ) as Record<string, unknown>;
    queue.rulesSha256 = rulesSha256;
    await writeJson(options.deletionReviewQueuePath, queue);
    const reviewedQueueSha256 = sha256(canonicalJson(queue));
    const decision = JSON.parse(
      await fs.readFile(options.deletionReviewDecisionPath, "utf8"),
    ) as Record<string, unknown>;
    decision.rulesSha256 = rulesSha256;
    decision.reviewedQueueSha256 = reviewedQueueSha256;
    await writeJson(options.deletionReviewDecisionPath, decision);
    const approval = JSON.parse(
      await fs.readFile(options.deletionApprovalPath, "utf8"),
    ) as Record<string, unknown>;
    const reviewDecisionSha256 = sha256(canonicalJson(decision));
    const deleteStageVersion = `delete-v1:${rulesSha256.slice(0, 12)}:${reviewedQueueSha256.slice(0, 12)}:${reviewDecisionSha256.slice(0, 12)}`;
    await writeJson(options.deletionApprovalPath, {
      ...approval,
      deleteStageVersion,
      rulesSha256,
      reviewedQueueSha256,
      reviewDecisionSha256,
    });

    await expect(verifyCorpus(options)).rejects.toThrow(
      "deletion review queue does not match canonical grouping",
    );
  });

  it("rejects split groups that permit contradictory thread decisions", async () => {
    const options = await fixture(
      baseMessage({ labels: ["Sensitive", "Delete"] }),
    );
    const rules = {
      schemaVersion: 1,
      rulesetVersion: RULESET,
      attachmentPolicy: {
        embeddedBytes: "drop",
        retainMetadata: ["filename", "mimeType", "sha256"],
      },
      rules: [
        {
          id: "thread-sensitive",
          enabled: true,
          scope: "thread",
          match: { type: "label", value: "Sensitive" },
        },
        {
          id: "message-delete",
          enabled: true,
          scope: "message",
          match: { type: "label", value: "Delete" },
        },
      ],
    };
    await writeJson(options.deletionRulesPath, rules);
    const rulesSha256 = sha256(
      canonicalJson({
        ...rules,
        rules: [...rules.rules].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    );
    const queue = JSON.parse(
      await fs.readFile(options.deletionReviewQueuePath, "utf8"),
    ) as Record<string, unknown>;
    const threadRuleHashes = [sha256("thread-sensitive")];
    const messageRuleHashes = [sha256("message-delete")];
    const threadGroupId = sha256(
      canonicalJson({
        scope: "thread",
        platform: "gmail",
        messageIds: ["message-1"],
        ruleIdHashes: threadRuleHashes,
      }),
    );
    const messageGroupId = sha256(
      canonicalJson({
        scope: "message",
        platform: "gmail",
        messageIds: ["message-1"],
        ruleIdHashes: messageRuleHashes,
      }),
    );
    Object.assign(queue, {
      rulesSha256,
      groups: [
        {
          groupId: threadGroupId,
          scope: "thread",
          platform: "gmail",
          messageIds: ["message-1"],
          ruleIdHashes: threadRuleHashes,
          matchClasses: ["label"],
          redactedContext: "kept thread",
          suggestedDecision: "delete",
        },
        {
          groupId: messageGroupId,
          scope: "message",
          platform: "gmail",
          messageIds: ["message-1"],
          ruleIdHashes: messageRuleHashes,
          matchClasses: ["label"],
          redactedContext: "deleted message",
          suggestedDecision: "delete",
        },
      ],
    });
    await writeJson(options.deletionReviewQueuePath, queue);
    const reviewedQueueSha256 = sha256(canonicalJson(queue));
    const decision = {
      schemaVersion: 1,
      rulesetVersion: RULESET,
      corpusDigest: queue.corpusDigest,
      rulesSha256,
      reviewedQueueSha256,
      approved: true,
      reviewedBy: "test-owner",
      reviewedAt: GENERATED_AT,
      decisions: [
        { groupId: threadGroupId, decision: "keep" },
        { groupId: messageGroupId, decision: "delete" },
      ],
    };
    await writeJson(options.deletionReviewDecisionPath, decision);
    const reviewDecisionSha256 = sha256(canonicalJson(decision));
    const approval = JSON.parse(
      await fs.readFile(options.deletionApprovalPath, "utf8"),
    ) as Record<string, unknown>;
    await writeJson(options.deletionApprovalPath, {
      ...approval,
      rulesSha256,
      reviewedQueueSha256,
      reviewDecisionSha256,
      deleteStageVersion: `delete-v1:${rulesSha256.slice(0, 12)}:${reviewedQueueSha256.slice(0, 12)}:${reviewDecisionSha256.slice(0, 12)}`,
      tombstoneCount: 1,
      tombstoneIdsSha256: sha256(canonicalJson(["message-1"])),
      survivorCount: 0,
    });

    await expect(verifyCorpus(options)).rejects.toThrow(
      "deletion review queue does not match canonical grouping",
    );
  });

  it("fails a ledger whose stage chain does not reach the final output", async () => {
    const options = await fixture(baseMessage());
    const records = (await fs.readFile(options.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const terminal = records.at(-1);
    if (!terminal) throw new Error("fixture ledger has no terminal record");
    terminal.inputHash = "7".repeat(64);
    terminal.markerKey = [
      `pii:${terminal.inputHash}:v${RULESET}`,
      terminal.stage,
      terminal.stageVersion,
    ].join(":");
    await fs.writeFile(
      options.ledgerPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "ledger",
        detector: "broken-stage-chain",
      }),
    );
  });

  it("rejects a survivor delete record that changes content", async () => {
    const options = await fixture(baseMessage());
    const records = (await fs.readFile(options.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deleteRecord = records.find((record) => record.stage === "delete");
    const rewriteRecord = records.find((record) => record.stage === "rewrite");
    if (!deleteRecord || !rewriteRecord || !deleteRecord.output) {
      throw new Error("fixture is missing delete/rewrite records");
    }
    const maliciousOutput = {
      ...(deleteRecord.output as CorpusMessage),
      text: "Delete stage changed content.",
    };
    const maliciousHash = sha256(JSON.stringify(maliciousOutput));
    deleteRecord.output = maliciousOutput;
    deleteRecord.outputHash = maliciousHash;
    rewriteRecord.inputHash = maliciousHash;
    rewriteRecord.markerKey = [
      `pii:${maliciousHash}:v${RULESET}`,
      "rewrite",
      rewriteRecord.stageVersion,
    ].join(":");
    await fs.writeFile(
      options.ledgerPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        detector: "invalid-deletion-survivor-transform",
      }),
    );
  });

  it("rejects a message that has both an approved tombstone and a live branch", async () => {
    const options = await fixture(baseMessage({ labels: ["Delete"] }));
    const rules = JSON.parse(
      await fs.readFile(options.deletionRulesPath, "utf8"),
    ) as Record<string, unknown>;
    rules.rules = [
      {
        id: "delete-label",
        enabled: true,
        scope: "message",
        match: { type: "label", value: "Delete" },
      },
    ];
    await writeJson(options.deletionRulesPath, rules);
    const rulesSha256 = sha256(canonicalJson(rules));
    const queue = JSON.parse(
      await fs.readFile(options.deletionReviewQueuePath, "utf8"),
    ) as Record<string, unknown>;
    const ruleIdHashes = [sha256("delete-label")];
    const groupId = sha256(
      canonicalJson({
        scope: "message",
        platform: "gmail",
        messageIds: ["message-1"],
        ruleIdHashes,
      }),
    );
    queue.rulesSha256 = rulesSha256;
    queue.groups = [
      {
        groupId,
        scope: "message",
        platform: "gmail",
        messageIds: ["message-1"],
        ruleIdHashes,
        matchClasses: ["label"],
        redactedContext: "Scrubbed body.",
        suggestedDecision: "delete",
      },
    ];
    await writeJson(options.deletionReviewQueuePath, queue);
    const reviewedQueueSha256 = sha256(canonicalJson(queue));
    const decision = {
      schemaVersion: 1,
      rulesetVersion: RULESET,
      corpusDigest: queue.corpusDigest,
      rulesSha256,
      reviewedQueueSha256,
      approved: true,
      reviewedBy: "test-owner",
      reviewedAt: GENERATED_AT,
      decisions: [{ groupId, decision: "delete" }],
    };
    await writeJson(options.deletionReviewDecisionPath, decision);
    const approval = JSON.parse(
      await fs.readFile(options.deletionApprovalPath, "utf8"),
    ) as Record<string, unknown>;
    const reviewDecisionSha256 = sha256(canonicalJson(decision));
    const deleteStageVersion = `delete-v1:${rulesSha256.slice(0, 12)}:${reviewedQueueSha256.slice(0, 12)}:${reviewDecisionSha256.slice(0, 12)}`;
    await writeJson(options.deletionApprovalPath, {
      ...approval,
      deleteStageVersion,
      rulesSha256,
      reviewedQueueSha256,
      reviewDecisionSha256,
      tombstoneIdsSha256: sha256(canonicalJson(["message-1"])),
      tombstoneCount: 1,
    });
    const tombstoneInputHash = "9".repeat(64);
    const tombstoneMetadata = {
      messageId: "message-1",
      stage: "delete",
      stageVersion: deleteStageVersion,
      rulesSha256,
      reviewedQueueSha256,
      reviewDecisionSha256,
      ruleIdHashes: [sha256("forged-deletion-reason")],
      scope: "message",
    };
    await fs.appendFile(
      options.ledgerPath,
      `${JSON.stringify({
        markerKey: `pii:${tombstoneInputHash}:v${RULESET}:delete:${deleteStageVersion}`,
        ...tombstoneMetadata,
        rulesetVersion: RULESET,
        inputHash: tombstoneInputHash,
        outputHash: sha256(
          canonicalJson({ tombstone: true, ...tombstoneMetadata }),
        ),
        tombstone: true,
      })}\n`,
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "tombstone-live-conflict" }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "broken-tombstone-chain" }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        detector: "deletion-tombstone-review-binding",
      }),
    );
  });

  it("fails if live shard bytes change while scanners are running", async () => {
    const options = await fixture(baseMessage());
    const shardPath = path.join(
      options.targetPath,
      "gmail",
      "work",
      "2026-06.jsonl",
    );
    options.gitleaksScanner = async () => {
      await fs.appendFile(shardPath, " ");
      return { version: "test-gitleaks", findings: [] };
    };

    await expect(verifyCorpus(options)).rejects.toThrow(
      "corpus shards changed during verification",
    );
  });

  it("fails if an auxiliary artifact changes while scanners are running", async () => {
    const options = await fixture(baseMessage());
    options.gitleaksScanner = async () => {
      await fs.appendFile(options.candidatesPath, " ");
      return { version: "test-gitleaks", findings: [] };
    };

    await expect(verifyCorpus(options)).rejects.toThrow(
      "candidatesSha256 changed during verification",
    );
  });

  it("fails if a shard is added while scanners are running", async () => {
    const options = await fixture(baseMessage());
    options.gitleaksScanner = async () => {
      const added = path.join(
        options.targetPath,
        "gmail",
        "work",
        "2026-07.jsonl",
      );
      await fs.writeFile(added, "{}\n");
      return { version: "test-gitleaks", findings: [] };
    };

    await expect(verifyCorpus(options)).rejects.toThrow(
      "corpus shard set changed during verification",
    );
  });

  it.each([
    ["text", (leaked: string) => baseMessage({ text: leaked })],
    [
      "subject",
      (leaked: string) => baseMessage({ subject: leaked.toUpperCase() }),
    ],
    ["sender id", (leaked: string) => baseMessage({ senderId: leaked })],
    [
      "sender display",
      (leaked: string) => baseMessage({ senderDisplay: leaked }),
    ],
    [
      "recipient address",
      (leaked: string) =>
        baseMessage({ recipients: [{ id: "recipient-1", address: leaked }] }),
    ],
    [
      "recipient display",
      (leaked: string) =>
        baseMessage({ recipients: [{ id: "recipient-1", display: leaked }] }),
    ],
    ["snippet", (leaked: string) => baseMessage({ snippet: leaked })],
    ["label", (leaked: string) => baseMessage({ labels: [leaked] })],
    [
      "attachment filename",
      (leaked: string) =>
        baseMessage({
          attachments: [
            {
              filename: leaked,
              mimeType: "text/plain",
              sha256: "a".repeat(64),
            },
          ],
        }),
    ],
  ])("fails on a planted email in %s without persisting cleartext", async (_field, build) => {
    const leaked = "owner-private@example.com";
    const options = await fixture(build(leaked), {
      candidate: leaked,
      canaryPlaceholder: "[[SECRET:openai-key:0123456789ab]]",
    });
    const report = await verifyCorpus(options);
    const serialized = JSON.stringify(report);

    expect(report.status).toBe("failed");
    expect(report.counts["structured-pii"]).toBeGreaterThan(0);
    expect(report.counts["original-value"]).toBeGreaterThan(0);
    expect(serialized.toLowerCase()).not.toContain(leaked);
  });

  it("fails missing canaries, malformed placeholders, and embedded bytes", async () => {
    const malformed = "[[SECRET:openai-key:ABC]]";
    const options = await fixture(
      baseMessage({
        text: malformed,
        attachments: [
          {
            filename: "safe.bin",
            mimeType: "application/octet-stream",
            sha256: "a".repeat(64),
            dataBase64: "c2VjcmV0",
          },
        ],
      }),
      { canaryPlaceholder: "[[SECRET:openai-key:0123456789ab]]" },
    );
    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.counts.canary).toBe(1);
    expect(report.counts.placeholder).toBeGreaterThan(0);
    expect(report.counts["attachment-policy"]).toBe(1);
  });

  it("rejects retained attachment byte counts without base64 payloads", async () => {
    const options = await fixture(
      baseMessage({
        attachments: [
          {
            filename: "safe.bin",
            mimeType: "application/octet-stream",
            sha256: "a".repeat(64),
            bytes: 8,
          },
        ],
      }),
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.counts["attachment-policy"]).toBe(1);
  });

  it.each([
    ["malformed", "***", undefined, "invalid base64 payload"],
    ["size mismatch", "c2VjcmV0", 7, "inconsistent payload bytes"],
  ])("rejects %s embedded attachment byte evidence", async (_name, dataBase64, bytes, expectedError) => {
    const options = await fixture(
      baseMessage({
        attachments: [
          {
            filename: "unsafe.bin",
            mimeType: "application/octet-stream",
            sha256: "a".repeat(64),
            dataBase64,
            bytes,
          },
        ],
      }),
    );
    const rules = JSON.parse(
      await fs.readFile(options.deletionRulesPath, "utf8"),
    ) as Record<string, unknown>;
    await rebindDeletionArtifacts(options, rules);

    await expect(verifyCorpus(options)).rejects.toThrow(expectedError);
  });

  it("rejects a placeholder without a matching mined candidate", async () => {
    const forgedPlaceholder = "[[SECRET:openai-key:0123456789ab]]";
    const options = await fixture(
      baseMessage({ text: `Scrubbed body ${forgedPlaceholder}` }),
      { canaryPlaceholder: forgedPlaceholder },
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "placeholder-registry" }),
    );
  });

  it("rejects PII hidden in an unknown top-level message field", async () => {
    const options = await fixture(baseMessage());
    const shardPath = path.join(
      options.targetPath,
      "gmail",
      "work",
      "2026-06.jsonl",
    );
    const row: unknown = JSON.parse(await fs.readFile(shardPath, "utf8"));
    if (typeof row !== "object" || row === null) {
      throw new Error("fixture row is not an object");
    }
    Object.assign(row, { metadata: { ownerName: "original-owner-name" } });
    await fs.writeFile(shardPath, `${JSON.stringify(row)}\n`);

    await expect(verifyCorpus(options)).rejects.toThrow("Unrecognized key");
  });

  it("rejects PII hidden in an unknown nested attachment field", async () => {
    const options = await fixture(
      baseMessage({
        attachments: [
          {
            filename: "safe.txt",
            mimeType: "text/plain",
            sha256: "a".repeat(64),
          },
        ],
      }),
    );
    const shardPath = path.join(
      options.targetPath,
      "gmail",
      "work",
      "2026-06.jsonl",
    );
    const row: unknown = JSON.parse(await fs.readFile(shardPath, "utf8"));
    if (typeof row !== "object" || row === null) {
      throw new Error("fixture row is not an object");
    }
    const attachments = Reflect.get(row, "attachments");
    if (!Array.isArray(attachments) || !attachments[0]) {
      throw new Error("fixture row has no attachment");
    }
    Object.assign(attachments[0], { ownerName: "original-owner-name" });
    await fs.writeFile(shardPath, `${JSON.stringify(row)}\n`);

    await expect(verifyCorpus(options)).rejects.toThrow("Unrecognized key");
  });

  it("ignores historical tombstones from a stale delete-stage version", async () => {
    const placeholder = defaultCanaryPlaceholder();
    const options = await fixture(
      baseMessage({ text: `Scrubbed body ${placeholder}` }),
      { canaryPlaceholder: placeholder },
    );
    const staleInputHash = "5".repeat(64);
    await fs.appendFile(
      options.ledgerPath,
      `${JSON.stringify({
        markerKey: `pii:${staleInputHash}:v${RULESET}:delete:delete-v0`,
        messageId: "historical-message",
        stage: "delete",
        stageVersion: "delete-v0",
        rulesetVersion: RULESET,
        inputHash: staleInputHash,
        outputHash: sha256(canonicalJson({ tombstone: true })),
        tombstone: true,
      })}\n`,
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("passed");
  });

  it("does not satisfy a delete canary with a stale tombstone", async () => {
    const options = await fixture(baseMessage());
    await writeJson(options.canariesPath, {
      schemaVersion: 1,
      rulesetVersion: RULESET,
      canaries: [
        {
          id: "delete-canary",
          messageId: "message-1",
          expected: { outcome: "tombstone", stage: "delete" },
        },
      ],
    });
    const staleInputHash = "5".repeat(64);
    await fs.appendFile(
      options.ledgerPath,
      `${JSON.stringify({
        markerKey: `pii:${staleInputHash}:v${RULESET}:delete:delete-v0`,
        messageId: "message-1",
        stage: "delete",
        stageVersion: "delete-v0",
        rulesetVersion: RULESET,
        inputHash: staleInputHash,
        outputHash: sha256(canonicalJson({ tombstone: true })),
        tombstone: true,
      })}\n`,
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "canary-tombstone" }),
    );
  });

  it("rejects a live chain that passed through a stale delete stage", async () => {
    const options = await fixture(baseMessage());
    const records = (await fs.readFile(options.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deletion = records.find((record) => record.stage === "delete");
    if (!deletion) throw new Error("fixture ledger has no delete record");
    deletion.stageVersion = "delete-v0";
    deletion.markerKey = [
      `pii:${deletion.inputHash}:v${RULESET}`,
      "delete",
      deletion.stageVersion,
    ].join(":");
    await fs.writeFile(
      options.ledgerPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const report = await verifyCorpus(options);

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ detector: "broken-stage-chain" }),
    );
  });

  it("fails closed when the gitleaks executable is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitleaks-missing-"));
    temporaryDirectories.push(root);
    await expect(
      scanShardsWithGitleaks([], {
        binaryPath: path.join(root, "missing-gitleaks"),
        configPath: path.join(root, "config.toml"),
        workDir: root,
      }),
    ).rejects.toThrow();
  });

  it.each([
    "missing",
    "empty",
  ] as const)("fails closed when gitleaks exits one with a %s report", async (reportMode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitleaks-report-"));
    temporaryDirectories.push(root);
    const shardPath = path.join(root, "shard.jsonl");
    const configPath = path.join(root, "config.toml");
    await fs.writeFile(shardPath, '{"secret":"planted"}\n');
    await fs.writeFile(configPath, 'title = "test"\n');

    await expect(
      scanShardsWithGitleaks([shardPath], {
        binaryPath: await fakeGitleaks(root, reportMode),
        configPath,
        workDir: root,
      }),
    ).rejects.toThrow(/produced no report|report was empty/);
  });
});
