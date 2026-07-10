/**
 * Fail-closed verification for a scrubbed personal corpus. The verifier scans
 * the exact shard bytes with gitleaks and the runtime detector floor, checks
 * original-value and canary invariants, and emits a sanitized report. Publisher
 * authorization reruns the full gate; the report's digest detects corruption
 * but is never treated as an authentication signature.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  detectPii,
  GazetteerEntityRecognizer,
  getDefaultRedactPatterns,
  RegexEntityRecognizer,
} from "@elizaos/core";
import { z } from "zod";
import { minePiiCandidates } from "./pipeline/mine.ts";
import {
  type CorpusMessage,
  corpusAttachmentSchema,
  corpusManifestSchema,
  corpusMessageSchema,
  corpusPlatforms,
  corpusRecipientSchema,
} from "./schema.ts";
import { findCorpusShardFiles } from "./validator.ts";

const verificationMessageSchema = corpusMessageSchema
  .extend({
    recipients: z.array(corpusRecipientSchema.strict()),
    attachments: z.array(corpusAttachmentSchema.strict()),
  })
  .strict();

const candidateSchema = z.object({
  msgId: z.string().min(1),
  sourceRef: z.object({
    tableName: z.literal("corpus_messages"),
    memoryId: z.string().min(1),
    threadId: z.string().min(1),
    platform: z.enum(corpusPlatforms),
    accountId: z.string().min(1),
    field: z.literal("text"),
    span: z.object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    }),
  }),
  kind: z.string().min(1),
  surfaceForm: z.string().min(1),
  valueHash: z.string().regex(/^[a-f0-9]{64}$/),
});

const canaryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  rulesetVersion: z.string().min(1),
  canaries: z
    .array(
      z.object({
        id: z.string().min(1),
        messageId: z.string().min(1),
        expected: z.discriminatedUnion("outcome", [
          z.object({
            outcome: z.literal("placeholder"),
            value: z
              .string()
              .regex(/^\[\[(?:SECRET|PII):[a-z0-9-]+:[a-f0-9]{12}\]\]$/),
          }),
          z.object({
            outcome: z.literal("tombstone"),
            stage: z.string().min(1),
          }),
        ]),
      }),
    )
    .min(1),
});

const deletionApprovalSchema = z.object({
  schemaVersion: z.literal(1),
  rulesetVersion: z.string().min(1),
  corpusDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidatesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  deleteStageVersion: z.string().min(1),
  approved: z.literal(true),
  rulesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedQueueSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewDecisionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tombstoneIdsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tombstoneCount: z.number().int().nonnegative(),
  survivorCount: z.number().int().nonnegative(),
  attachmentBytesDropped: z.number().int().nonnegative(),
});

const deletionRuleBaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    enabled: z.boolean(),
  })
  .strict();

const deletionRuleSchema = z.union([
  deletionRuleBaseSchema
    .extend({
      scope: z.literal("thread"),
      match: z
        .object({
          type: z.literal("thread"),
          platform: z.enum(corpusPlatforms),
          accountId: z.string().min(1),
          threadId: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  deletionRuleBaseSchema
    .extend({
      scope: z.literal("thread"),
      match: z
        .object({
          type: z.literal("contact"),
          platform: z.enum(corpusPlatforms),
          accountId: z.string().min(1),
          contactId: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  deletionRuleBaseSchema
    .extend({
      scope: z.enum(["message", "thread"]),
      match: z
        .object({
          type: z.literal("detector"),
          kind: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        })
        .strict(),
    })
    .strict(),
  deletionRuleBaseSchema
    .extend({
      scope: z.enum(["message", "thread"]),
      match: z
        .object({
          type: z.literal("keyword"),
          value: z.string().min(2),
          mode: z.enum(["token", "substring"]),
          fields: z
            .array(
              z.enum([
                "subject",
                "text",
                "snippet",
                "labels",
                "attachment-filename",
              ]),
            )
            .min(1),
        })
        .strict(),
    })
    .strict(),
  deletionRuleBaseSchema
    .extend({
      scope: z.enum(["message", "thread"]),
      match: z
        .object({
          type: z.literal("label"),
          value: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

const deletionRulesArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.string().min(1),
    attachmentPolicy: z
      .object({
        embeddedBytes: z.literal("drop"),
        retainMetadata: z.tuple([
          z.literal("filename"),
          z.literal("mimeType"),
          z.literal("sha256"),
        ]),
      })
      .strict(),
    rules: z.array(deletionRuleSchema),
  })
  .strict();

const deletionReviewQueueSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.string().min(1),
    corpusDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rulesSha256: z.string().regex(/^[a-f0-9]{64}$/),
    candidatesSha256: z.string().regex(/^[a-f0-9]{64}$/),
    groups: z.array(
      z
        .object({
          groupId: z.string().regex(/^[a-f0-9]{64}$/),
          scope: z.enum(["message", "thread"]),
          platform: z.enum(corpusPlatforms),
          messageIds: z.array(z.string().min(1)).min(1),
          ruleIdHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
          matchClasses: z
            .array(
              z.enum(["contact", "detector", "keyword", "label", "thread"]),
            )
            .min(1),
          redactedContext: z.string().min(1),
          suggestedDecision: z.literal("delete"),
        })
        .strict(),
    ),
  })
  .strict();

const deletionReviewDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.string().min(1),
    corpusDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rulesSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedQueueSha256: z.string().regex(/^[a-f0-9]{64}$/),
    approved: z.literal(true),
    reviewedBy: z.string().min(1),
    reviewedAt: z.string().datetime({ offset: true }),
    decisions: z.array(
      z
        .object({
          groupId: z.string().regex(/^[a-f0-9]{64}$/),
          decision: z.enum(["delete", "keep"]),
        })
        .strict(),
    ),
  })
  .strict();

const placeholderRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  rulesetVersion: z.string().min(1),
  entries: z.array(
    z.object({
      placeholder: z
        .string()
        .regex(/^\[\[(?:SECRET|PII):[a-z0-9-]+:[a-f0-9]{12}\]\]$/),
      kind: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      valueHash: z.string().regex(/^[a-f0-9]{64}$/),
      stage: z.literal("secrets"),
      messageId: z.string().min(1),
    }),
  ),
});

const gazetteerSchema = z
  .array(
    z.object({
      kind: z.string().min(1),
      value: z.string().trim().min(2),
    }),
  )
  .min(1);

const ledgerRecordSchema = z.object({
  markerKey: z.string().min(1),
  messageId: z.string().min(1),
  stage: z.string().min(1),
  stageVersion: z.string().min(1),
  rulesetVersion: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/),
  tombstone: z.boolean(),
  output: verificationMessageSchema.optional(),
  rulesSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  reviewedQueueSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  reviewDecisionSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  ruleIdHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  scope: z.enum(["message", "thread"]).optional(),
});

const gitleaksFindingSchema = z.object({
  RuleID: z.string().optional(),
  File: z.string().optional(),
  StartLine: z.number().int().nonnegative().optional(),
  Fingerprint: z.string().optional(),
});

export type VerificationFindingKind =
  | "attachment-policy"
  | "canary"
  | "entity"
  | "gitleaks"
  | "ledger"
  | "original-value"
  | "placeholder"
  | "redact-pattern"
  | "structured-pii";

export interface VerificationFinding {
  kind: VerificationFindingKind;
  detector: string;
  messageId?: string;
  field?: string;
  valueHash: string;
}

export interface CorpusVerificationReport {
  schemaVersion: 1;
  scope: "jsonl-text-v1";
  generatedAt: string;
  rulesetVersion: string;
  status: "passed" | "failed";
  corpusDigest: string;
  shardCount: number;
  messageCount: number;
  candidateCount: number;
  canaryCount: number;
  inputs: {
    manifestSha256: string;
    ledgerSha256: string;
    candidatesSha256: string;
    canariesSha256: string;
    gazetteerSha256: string;
    deletionRulesSha256: string;
    deletionReviewQueueSha256: string;
    deletionReviewDecisionSha256: string;
    deletionApprovalSha256: string;
    placeholderRegistrySha256: string;
    gitleaksConfigSha256: string;
  };
  scanner: { name: "gitleaks"; version: string; findingCount: number };
  counts: Record<VerificationFindingKind, number>;
  findings: VerificationFinding[];
  reportDigest: string;
}

export interface GitleaksResult {
  version: string;
  findings: VerificationFinding[];
}

export type GitleaksScanner = (
  shardPaths: readonly string[],
  options: { binaryPath: string; configPath: string; workDir: string },
) => Promise<GitleaksResult>;

export interface VerifyCorpusOptions {
  targetPath: string;
  candidatesPath: string;
  canariesPath: string;
  manifestPath: string;
  ledgerPath: string;
  gazetteerPath: string;
  deletionRulesPath: string;
  deletionReviewQueuePath: string;
  deletionReviewDecisionPath: string;
  deletionApprovalPath: string;
  placeholderRegistryPath: string;
  rulesetVersion: string;
  reportPath?: string;
  gitleaksBinaryPath?: string;
  gitleaksConfigPath?: string;
  gitleaksScanner?: GitleaksScanner;
  now?: () => Date;
}

const verificationInputKeys = [
  "manifestSha256",
  "ledgerSha256",
  "candidatesSha256",
  "canariesSha256",
  "gazetteerSha256",
  "deletionRulesSha256",
  "deletionReviewQueueSha256",
  "deletionReviewDecisionSha256",
  "deletionApprovalSha256",
  "placeholderRegistrySha256",
  "gitleaksConfigSha256",
] as const;

interface StringField {
  field: string;
  value: string;
}

interface ShardSnapshot {
  path: string;
  bytes: Buffer;
}

const VALID_PLACEHOLDER_GLOBAL =
  /\[\[(?:SECRET|PII):[a-z0-9-]+:[a-f0-9]{12}\]\]/g;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function verificationInputHashes(
  options: VerifyCorpusOptions,
  gitleaksConfigPath: string,
): Promise<CorpusVerificationReport["inputs"]> {
  return {
    manifestSha256: sha256(await fs.readFile(options.manifestPath)),
    ledgerSha256: sha256(await fs.readFile(options.ledgerPath)),
    candidatesSha256: sha256(await fs.readFile(options.candidatesPath)),
    canariesSha256: sha256(await fs.readFile(options.canariesPath)),
    gazetteerSha256: sha256(await fs.readFile(options.gazetteerPath)),
    deletionRulesSha256: sha256(await fs.readFile(options.deletionRulesPath)),
    deletionReviewQueueSha256: sha256(
      await fs.readFile(options.deletionReviewQueuePath),
    ),
    deletionReviewDecisionSha256: sha256(
      await fs.readFile(options.deletionReviewDecisionPath),
    ),
    deletionApprovalSha256: sha256(
      await fs.readFile(options.deletionApprovalPath),
    ),
    placeholderRegistrySha256: sha256(
      await fs.readFile(options.placeholderRegistryPath),
    ),
    gitleaksConfigSha256: sha256(await fs.readFile(gitleaksConfigPath)),
  };
}

function findingHash(detector: string, value: string): string {
  return sha256(`${detector}\0${value}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function reportDigest(
  report: Omit<CorpusVerificationReport, "reportDigest">,
): string {
  return sha256(canonicalJson(report));
}

async function readJsonLines<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const rows: T[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parsed = schema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(
        `invalid ${filePath} line ${index + 1}: ${z.prettifyError(parsed.error)}`,
      );
    }
    rows.push(parsed.data);
  }
  return rows;
}

async function readMessages(
  targetPath: string,
  snapshots: readonly ShardSnapshot[],
): Promise<{
  messages: CorpusMessage[];
  manifestShards: Array<{
    path: string;
    platform: (typeof corpusPlatforms)[number];
    accountId: string;
    month: string;
    count: number;
    firstTs: number;
    lastTs: number;
    sha256: string;
  }>;
}> {
  const rootDir = path.extname(targetPath)
    ? path.dirname(targetPath)
    : targetPath;
  const messages: CorpusMessage[] = [];
  const manifestShards: Array<{
    path: string;
    platform: (typeof corpusPlatforms)[number];
    accountId: string;
    month: string;
    count: number;
    firstTs: number;
    lastTs: number;
    sha256: string;
  }> = [];
  const messageIds = new Set<string>();
  for (const snapshot of snapshots) {
    const relative = path.relative(rootDir, snapshot.path).split(path.sep);
    const shardMessages: CorpusMessage[] = [];
    for (const [index, line] of snapshot.bytes
      .toString("utf8")
      .split(/\r?\n/)
      .entries()) {
      if (!line.trim()) continue;
      const parsed = verificationMessageSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(
          `invalid verification input ${snapshot.path} line ${index + 1}: ${z.prettifyError(parsed.error)}`,
        );
      }
      const message = parsed.data;
      if (
        relative.length >= 3 &&
        (message.platform !== relative[0] || message.accountId !== relative[1])
      ) {
        throw new Error(
          `message ${message.id} does not match its platform/account shard path`,
        );
      }
      if (messageIds.has(message.id)) {
        throw new Error(`duplicate message id across shards: ${message.id}`);
      }
      if (message.scrubState !== "rewritten") {
        throw new Error(
          `message ${message.id} must be rewritten before corpus verification`,
        );
      }
      messageIds.add(message.id);
      messages.push(message);
      shardMessages.push(message);
    }
    const platform = corpusPlatforms.find((value) => value === relative[0]);
    const accountId = relative[1];
    const month = relative[2]?.replace(/\.jsonl$/, "");
    if (!platform || !accountId || !month || shardMessages.length === 0) {
      throw new Error(
        `verification shard path must be <platform>/<account>/<yyyy-mm>.jsonl`,
      );
    }
    const timestamps = shardMessages
      .map((message) => message.ts)
      .sort((a, b) => a - b);
    manifestShards.push({
      path: relative.join("/"),
      platform,
      accountId,
      month,
      count: shardMessages.length,
      firstTs: timestamps[0],
      lastTs: timestamps[timestamps.length - 1],
      sha256: sha256(snapshot.bytes),
    });
  }
  return { messages, manifestShards };
}

async function digestShards(
  targetPath: string,
  shardPaths: readonly string[],
): Promise<string> {
  const rootDir = path.extname(targetPath)
    ? path.dirname(targetPath)
    : targetPath;
  const hash = createHash("sha256");
  for (const shardPath of [...shardPaths].sort()) {
    hash.update(path.relative(rootDir, shardPath));
    hash.update("\0");
    hash.update(await fs.readFile(shardPath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function digestSnapshots(
  targetPath: string,
  snapshots: readonly ShardSnapshot[],
): string {
  const rootDir = path.extname(targetPath)
    ? path.dirname(targetPath)
    : targetPath;
  const hash = createHash("sha256");
  for (const snapshot of [...snapshots].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(path.relative(rootDir, snapshot.path));
    hash.update("\0");
    hash.update(snapshot.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectStringFields(
  value: unknown,
  prefix = "message",
): StringField[] {
  if (typeof value === "string") return [{ field: prefix, value }];
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      collectStringFields(child, `${prefix}[${index}]`),
    );
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    collectStringFields(child, `${prefix}.${key}`),
  );
}

function parseRedactPatterns(): RegExp[] {
  return getDefaultRedactPatterns().map((raw) => {
    const slash = raw.match(/^\/(.+)\/([gimsuy]*)$/);
    try {
      if (slash) {
        const flags = slash[2].includes("g") ? slash[2] : `${slash[2]}g`;
        return new RegExp(slash[1], flags);
      }
      return new RegExp(raw, "gi");
    } catch (error) {
      throw new Error(`invalid core redact pattern ${JSON.stringify(raw)}`, {
        cause: error,
      });
    }
  });
}

function patternFindings(
  messageId: string,
  field: StringField,
  patterns: readonly RegExp[],
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const placeholderRanges = [
    ...field.value.matchAll(VALID_PLACEHOLDER_GLOBAL),
  ].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of field.value.matchAll(pattern)) {
      const value = match[match.length - 1] || match[0];
      if (!value) continue;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (
        placeholderRanges.some(
          (range) => start >= range.start && end <= range.end,
        )
      ) {
        continue;
      }
      findings.push({
        kind: "redact-pattern",
        detector: pattern.source,
        messageId,
        field: field.field,
        valueHash: findingHash(pattern.source, value),
      });
    }
  }
  return findings;
}

function placeholderFindings(
  messageId: string,
  field: StringField,
): VerificationFinding[] {
  const withoutValid = field.value.replace(VALID_PLACEHOLDER_GLOBAL, "");
  const invalidMarkers = [
    ...withoutValid.matchAll(/\[\[(?:SECRET|PII):[^\r\n]*/g),
    ...withoutValid.matchAll(/__ELIZA_SECRET_[A-Za-z0-9_]+__/g),
    ...withoutValid.matchAll(/\[REDACTED:[^\]\r\n]*\]/g),
  ].map((match) => match[0]);
  return invalidMarkers.map((value) => ({
    kind: "placeholder" as const,
    detector: "placeholder-integrity",
    messageId,
    field: field.field,
    valueHash: findingHash("placeholder-integrity", value),
  }));
}

async function detectorFindings(
  messages: readonly CorpusMessage[],
  gazetteerValues: readonly string[],
): Promise<VerificationFinding[]> {
  const patterns = parseRedactPatterns();
  const gazetteer = new GazetteerEntityRecognizer(
    gazetteerValues.map((value) => ({ kind: "original-value", value })),
    { name: "verification-gazetteer" },
  );
  const regexEntities = new RegexEntityRecognizer({
    address: true,
    email: true,
    phone: true,
  });
  const findings: VerificationFinding[] = [];
  for (const message of messages) {
    for (const field of collectStringFields(message)) {
      for (const match of detectPii(field.value)) {
        findings.push({
          kind: "structured-pii",
          detector: match.kind,
          messageId: message.id,
          field: field.field,
          valueHash: findingHash(match.kind, match.value),
        });
      }
      findings.push(...patternFindings(message.id, field, patterns));
      findings.push(...placeholderFindings(message.id, field));
      for (const recognizer of [gazetteer, regexEntities]) {
        const spans = await recognizer.recognize(field.value);
        for (const span of spans) {
          findings.push({
            kind: "entity",
            detector: recognizer.name,
            messageId: message.id,
            field: field.field,
            valueHash: findingHash(recognizer.name, span.value),
          });
        }
      }
    }
  }
  return findings;
}

function runCommand(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 310_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${binary} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function scanShardsWithGitleaks(
  shardPaths: readonly string[],
  options: { binaryPath: string; configPath: string; workDir: string },
): Promise<GitleaksResult> {
  const versionResult = await runCommand(
    options.binaryPath,
    ["version", "--no-banner"],
    options.workDir,
    30_000,
  );
  if (versionResult.code !== 0) {
    throw new Error(
      `gitleaks version probe failed with exit ${versionResult.code}`,
    );
  }
  const findings: VerificationFinding[] = [];
  const reportDir = await fs.mkdtemp(path.join(options.workDir, "gitleaks-"));
  try {
    for (const [index, shardPath] of shardPaths.entries()) {
      const rawReportPath = path.join(reportDir, `${index}.json`);
      const result = await runCommand(
        options.binaryPath,
        [
          "dir",
          shardPath,
          "--config",
          options.configPath,
          "--report-format",
          "json",
          "--report-path",
          rawReportPath,
          "--redact",
          "--no-banner",
          "--exit-code",
          "1",
          "--timeout",
          "300",
        ],
        options.workDir,
      );
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(
          `gitleaks failed for shard ${index + 1} with exit ${result.code}: ${result.stderr.trim().slice(0, 500)}`,
        );
      }
      let raw: string;
      try {
        await fs.chmod(rawReportPath, 0o600);
        raw = await fs.readFile(rawReportPath, "utf8");
      } catch (error) {
        // error-policy:J4 gitleaks omits its report when a shard has zero findings.
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
        if (result.code === 1) {
          throw new Error(
            `gitleaks reported findings for shard ${index + 1} but produced no report`,
            { cause: error },
          );
        }
        raw = "[]";
      }
      const parsed = z.array(gitleaksFindingSchema).safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(
          `invalid gitleaks JSON report: ${z.prettifyError(parsed.error)}`,
        );
      }
      if (result.code === 1 && parsed.data.length === 0) {
        throw new Error(
          `gitleaks reported findings for shard ${index + 1} but its report was empty`,
        );
      }
      for (const finding of parsed.data) {
        const detector = finding.RuleID ?? "unknown-rule";
        const fingerprint =
          finding.Fingerprint ??
          `${finding.File ?? path.basename(shardPath)}:${finding.StartLine ?? 0}:${detector}`;
        findings.push({
          kind: "gitleaks",
          detector,
          field: finding.File
            ? path.basename(finding.File)
            : path.basename(shardPath),
          valueHash: findingHash(detector, fingerprint),
        });
      }
    }
  } finally {
    // Raw reports can contain secrets, so deletion failure must fail the gate.
    await fs.rm(reportDir, { recursive: true, force: true });
  }
  return {
    version: versionResult.stdout.trim() || versionResult.stderr.trim(),
    findings,
  };
}

async function readGazetteerValues(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const values = gazetteerSchema.safeParse(JSON.parse(raw));
  if (!values.success) {
    throw new Error(`invalid gazetteer: ${z.prettifyError(values.error)}`);
  }
  return values.data.map((entry) => entry.value);
}

function registryFindings(
  messages: readonly CorpusMessage[],
  registry: z.infer<typeof placeholderRegistrySchema>,
  candidates: readonly z.infer<typeof candidateSchema>[],
  ledger: readonly z.infer<typeof ledgerRecordSchema>[],
): VerificationFinding[] {
  const byMessageAndPlaceholder = new Map(
    registry.entries.map((entry) => [
      `${entry.messageId}\0${entry.placeholder}`,
      entry,
    ]),
  );
  const used = new Set<string>();
  const findings: VerificationFinding[] = [];
  for (const message of messages) {
    for (const field of collectStringFields(message)) {
      for (const match of field.value.matchAll(VALID_PLACEHOLDER_GLOBAL)) {
        const placeholder = match[0];
        const key = `${message.id}\0${placeholder}`;
        const entry = byMessageAndPlaceholder.get(key);
        const encoded = placeholder.match(
          /^\[\[(?:SECRET|PII):([a-z0-9-]+):([a-f0-9]{12})\]\]$/,
        );
        const secretsRecords = ledger.filter(
          (record) =>
            record.rulesetVersion === registry.rulesetVersion &&
            record.messageId === message.id &&
            record.stage === "secrets" &&
            !record.tombstone &&
            record.output,
        );
        const secretsRecord = secretsRecords[0];
        const linkedMineRecord = secretsRecord
          ? ledger.find(
              (record) =>
                record.rulesetVersion === registry.rulesetVersion &&
                record.messageId === message.id &&
                record.stage === "mine" &&
                record.outputHash === secretsRecord.inputHash &&
                record.output,
            )
          : undefined;
        const transitioned =
          secretsRecords.length === 1 &&
          secretsRecord?.output !== undefined &&
          JSON.stringify(secretsRecord.output).includes(placeholder) &&
          linkedMineRecord?.output !== undefined &&
          !JSON.stringify(linkedMineRecord.output).includes(placeholder);
        const candidateBound = candidates.some(
          (candidate) =>
            candidate.msgId === message.id &&
            candidate.kind === entry?.kind &&
            candidate.valueHash === entry?.valueHash,
        );
        if (
          !entry ||
          !encoded ||
          entry.kind !== encoded[1] ||
          !entry.valueHash.startsWith(encoded[2]) ||
          !candidateBound ||
          !transitioned
        ) {
          findings.push({
            kind: "placeholder",
            detector: "placeholder-registry",
            messageId: message.id,
            field: field.field,
            valueHash: findingHash("placeholder-registry", placeholder),
          });
        } else {
          used.add(key);
        }
      }
    }
  }
  for (const entry of registry.entries) {
    const key = `${entry.messageId}\0${entry.placeholder}`;
    if (used.has(key)) continue;
    findings.push({
      kind: "placeholder",
      detector: "unused-placeholder-registry-entry",
      messageId: entry.messageId,
      valueHash: findingHash(
        "unused-placeholder-registry-entry",
        entry.placeholder,
      ),
    });
  }
  return findings;
}

function attachmentFindings(
  messages: readonly CorpusMessage[],
): VerificationFinding[] {
  return messages.flatMap((message) =>
    message.attachments
      .filter(
        (attachment) =>
          attachment.dataBase64 !== undefined || attachment.bytes !== undefined,
      )
      .map((attachment) => ({
        kind: "attachment-policy" as const,
        detector: "embedded-attachment-bytes",
        messageId: message.id,
        field: "message.attachments",
        valueHash: findingHash("embedded-attachment-bytes", attachment.sha256),
      })),
  );
}

function droppedAttachmentByteCount(
  messages: readonly CorpusMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    for (const attachment of message.attachments) {
      if (attachment.dataBase64 !== undefined) {
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            attachment.dataBase64,
          )
        ) {
          throw new Error(
            `attachment ${attachment.sha256} has invalid base64 payload`,
          );
        }
        const decoded = Buffer.from(attachment.dataBase64, "base64");
        if (
          decoded.toString("base64") !== attachment.dataBase64 ||
          (attachment.bytes !== undefined &&
            attachment.bytes !== decoded.length)
        ) {
          throw new Error(
            `attachment ${attachment.sha256} has inconsistent payload bytes`,
          );
        }
        total += decoded.length;
      } else if (attachment.bytes !== undefined) {
        total += attachment.bytes;
      }
      if (!Number.isSafeInteger(total)) {
        throw new Error("attachment byte total exceeds safe integer range");
      }
    }
  }
  return total;
}

async function validateManifestSnapshots(
  manifestPath: string,
  manifestShards: ReadonlyArray<
    z.infer<typeof corpusManifestSchema>["shards"][number]
  >,
): Promise<void> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const expected = corpusManifestSchema.parse(JSON.parse(raw));
  const actual = corpusManifestSchema.parse({
    schemaVersion: 1,
    generatedAt: expected.generatedAt,
    cutoffIso: expected.cutoffIso,
    shards: [...manifestShards],
    totals: {
      messages: manifestShards.reduce((sum, shard) => sum + shard.count, 0),
      contacts: 0,
      threads: 0,
    },
  });
  for (const entry of actual.shards) {
    if (
      path.isAbsolute(entry.path) ||
      entry.path.split("/").some((segment) => segment === "..")
    ) {
      throw new Error(`unsafe manifest shard path ${entry.path}`);
    }
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("manifest does not match the exact verification target");
  }
}

function originalValueFindings(
  messages: readonly CorpusMessage[],
  candidates: readonly z.infer<typeof candidateSchema>[],
): VerificationFinding[] {
  const canonicalize = (value: string): string =>
    value.normalize("NFKC").toLocaleLowerCase("en-US");
  const serialized = messages.map((message) =>
    canonicalize(JSON.stringify(message).replace(VALID_PLACEHOLDER_GLOBAL, "")),
  );
  const unique = new Map(
    candidates.map((candidate) => [candidate.valueHash, candidate]),
  );
  const findings: VerificationFinding[] = [];
  for (const candidate of unique.values()) {
    for (const [index, messageJson] of serialized.entries()) {
      if (!messageJson.includes(canonicalize(candidate.surfaceForm))) continue;
      findings.push({
        kind: "original-value",
        detector: candidate.kind,
        messageId: messages[index].id,
        valueHash: candidate.valueHash,
      });
    }
  }
  return findings;
}

function canaryFindings(
  messages: readonly CorpusMessage[],
  manifest: z.infer<typeof canaryManifestSchema>,
  ledger: readonly z.infer<typeof ledgerRecordSchema>[],
  deletionApproval: z.infer<typeof deletionApprovalSchema>,
  approvedDeletedIds: ReadonlySet<string>,
): VerificationFinding[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const findings: VerificationFinding[] = [];
  for (const canary of manifest.canaries) {
    let satisfied = false;
    if (canary.expected.outcome === "placeholder") {
      const message = byId.get(canary.messageId);
      satisfied = Boolean(
        message && JSON.stringify(message).includes(canary.expected.value),
      );
    } else {
      const expectedStage = canary.expected.stage;
      satisfied = ledger.some(
        (record) =>
          record.messageId === canary.messageId &&
          record.stage === expectedStage &&
          record.rulesetVersion === manifest.rulesetVersion &&
          record.tombstone &&
          (expectedStage !== "delete" ||
            (record.stageVersion === deletionApproval.deleteStageVersion &&
              approvedDeletedIds.has(record.messageId))),
      );
    }
    if (!satisfied) {
      findings.push({
        kind: "canary",
        detector: `canary-${canary.expected.outcome}`,
        messageId: canary.messageId,
        valueHash: findingHash("canary", canary.id),
      });
    }
  }
  return findings;
}

function deletionRuleMatches(
  message: CorpusMessage,
  rule: z.infer<typeof deletionRuleSchema>,
  candidateKinds: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const match = rule.match;
  const normalize = (value: string): string =>
    value.normalize("NFKC").toLocaleLowerCase("en-US");
  switch (match.type) {
    case "thread":
      return (
        message.platform === match.platform &&
        message.accountId === match.accountId &&
        message.threadId === match.threadId
      );
    case "contact": {
      if (
        message.platform !== match.platform ||
        message.accountId !== match.accountId
      ) {
        return false;
      }
      const contactId = normalize(match.contactId);
      return [
        message.senderId,
        ...message.recipients.flatMap((recipient) => [
          recipient.id,
          ...(recipient.address ? [recipient.address] : []),
        ]),
      ].some((participant) => normalize(participant) === contactId);
    }
    case "detector":
      return candidateKinds.get(message.id)?.has(match.kind) === true;
    case "label":
      return message.labels.some(
        (label) => normalize(label) === normalize(match.value),
      );
    case "keyword": {
      const values = match.fields.flatMap((field): string[] => {
        if (field === "text") return [message.text];
        if (field === "subject")
          return message.subject ? [message.subject] : [];
        if (field === "snippet")
          return message.snippet ? [message.snippet] : [];
        if (field === "labels") return message.labels;
        return message.attachments.map((attachment) => attachment.filename);
      });
      const needle = normalize(match.value);
      return values.some((value) => {
        const haystack = normalize(value);
        if (match.mode === "substring") return haystack.includes(needle);
        let from = 0;
        for (;;) {
          const index = haystack.indexOf(needle, from);
          if (index === -1) return false;
          const before = index === 0 ? undefined : haystack[index - 1];
          const after = haystack[index + needle.length];
          const isWord = (character: string | undefined): boolean =>
            character !== undefined && /[\p{L}\p{N}_]/u.test(character);
          if (!isWord(before) && !isWord(after)) return true;
          from = index + Math.max(needle.length, 1);
        }
      });
    }
  }
}

const deletionReviewRedactPatterns: readonly RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /(?<!\d)(?:\+?[1-9]\d{7,14}|(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4})(?!\d)/g,
  /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
  /\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:password|passcode|token|secret)\s*[:=]\s*\S+/gi,
];

function deletionRuleSensitiveTerms(
  rule: z.infer<typeof deletionRuleSchema>,
): string[] {
  const match = rule.match;
  if (match.type === "thread") return [match.threadId];
  if (match.type === "contact") return [match.contactId];
  if (match.type === "keyword" || match.type === "label") {
    return [match.value];
  }
  return [];
}

function replaceDeletionReviewTerm(text: string, value: string): string {
  if (!value) return text;
  const normalized = (candidate: string): string =>
    candidate.normalize("NFKC").toLocaleLowerCase("en-US");
  const lowerText = normalized(text);
  const lowerValue = normalized(value);
  if (lowerText.length !== text.length || lowerValue.length !== value.length) {
    return text;
  }
  let result = text;
  let search = lowerText;
  let from = 0;
  for (;;) {
    const index = search.indexOf(lowerValue, from);
    if (index === -1) return result;
    result = `${result.slice(0, index)}[MATCH]${result.slice(index + value.length)}`;
    search = normalized(result);
    from = index + "[MATCH]".length;
  }
}

function deletionReviewContext(
  message: CorpusMessage,
  sensitiveTerms: readonly string[],
): string {
  let value = [message.subject, message.text, message.snippet]
    .filter((item): item is string => Boolean(item))
    .join(" — ");
  for (const term of [...new Set(sensitiveTerms)].sort(
    (left, right) => right.length - left.length,
  )) {
    value = replaceDeletionReviewTerm(value, term);
  }
  for (const pattern of deletionReviewRedactPatterns) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, "[REDACTED]");
  }
  value = value.replace(/\s+/g, " ").trim();
  if (!value) return "[no textual preview]";
  const characters = [...value];
  return characters.length <= 60
    ? value
    : `${characters.slice(0, 59).join("")}…`;
}

function validateDeletionQueueSemantics(
  messages: readonly CorpusMessage[],
  candidates: readonly z.infer<typeof candidateSchema>[],
  rules: z.infer<typeof deletionRulesArtifactSchema>,
  queue: z.infer<typeof deletionReviewQueueSchema>,
): void {
  const candidateKinds = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const kinds = candidateKinds.get(candidate.msgId) ?? new Set<string>();
    kinds.add(candidate.kind);
    candidateKinds.set(candidate.msgId, kinds);
  }
  const messagesById = new Map(
    messages.map((message) => [message.id, message]),
  );
  const ruleByHash = new Map(
    rules.rules.map((rule) => [sha256(rule.id), rule]),
  );
  const enabledRules = rules.rules.filter((rule) => rule.enabled);
  const directMatches = new Map<
    string,
    Array<{ rule: z.infer<typeof deletionRuleSchema>; terms: string[] }>
  >();
  for (const message of messages) {
    const matches = enabledRules
      .filter((rule) => deletionRuleMatches(message, rule, candidateKinds))
      .map((rule) => ({
        rule,
        terms: deletionRuleSensitiveTerms(rule),
      }));
    if (matches.length > 0) directMatches.set(message.id, matches);
  }
  const threadKey = (message: CorpusMessage): string =>
    canonicalJson([message.platform, message.accountId, message.threadId]);
  const selectedThreadKeys = new Set<string>();
  for (const message of messages) {
    if (
      directMatches
        .get(message.id)
        ?.some((match) => match.rule.scope === "thread")
    ) {
      selectedThreadKeys.add(threadKey(message));
    }
  }
  const expectedGroups: Array<
    z.infer<typeof deletionReviewQueueSchema>["groups"][number]
  > = [];
  const threadCoveredMessages = new Set<string>();
  for (const key of selectedThreadKeys) {
    const members = messages
      .filter((message) => threadKey(message) === key)
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const member of members) threadCoveredMessages.add(member.id);
    const matches = members.flatMap(
      (member) => directMatches.get(member.id) ?? [],
    );
    const groupRules = [
      ...new Map(matches.map((match) => [match.rule.id, match.rule])).values(),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const messageIds = members.map((message) => message.id);
    const ruleIdHashes = groupRules.map((rule) => sha256(rule.id));
    const matchClasses = [
      ...new Set(groupRules.map((rule) => rule.match.type)),
    ].sort();
    const preview = members[0];
    if (!preview) throw new Error("deletion review thread group is empty");
    expectedGroups.push({
      groupId: sha256(
        canonicalJson({
          scope: "thread",
          platform: preview.platform,
          messageIds,
          ruleIdHashes,
        }),
      ),
      scope: "thread",
      platform: preview.platform,
      messageIds,
      ruleIdHashes,
      matchClasses,
      redactedContext: deletionReviewContext(
        preview,
        matches.flatMap((match) => match.terms),
      ),
      suggestedDecision: "delete",
    });
  }
  for (const message of messages) {
    if (threadCoveredMessages.has(message.id)) continue;
    const matches = (directMatches.get(message.id) ?? []).filter(
      (match) => match.rule.scope === "message",
    );
    if (matches.length === 0) continue;
    const groupRules = [
      ...new Map(matches.map((match) => [match.rule.id, match.rule])).values(),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const messageIds = [message.id];
    const ruleIdHashes = groupRules.map((rule) => sha256(rule.id));
    const matchClasses = [
      ...new Set(groupRules.map((rule) => rule.match.type)),
    ].sort();
    expectedGroups.push({
      groupId: sha256(
        canonicalJson({
          scope: "message",
          platform: message.platform,
          messageIds,
          ruleIdHashes,
        }),
      ),
      scope: "message",
      platform: message.platform,
      messageIds,
      ruleIdHashes,
      matchClasses,
      redactedContext: deletionReviewContext(
        message,
        matches.flatMap((match) => match.terms),
      ),
      suggestedDecision: "delete",
    });
  }
  if (
    canonicalJson(
      [...queue.groups].sort((a, b) => a.groupId.localeCompare(b.groupId)),
    ) !==
    canonicalJson(
      expectedGroups.sort((a, b) => a.groupId.localeCompare(b.groupId)),
    )
  ) {
    throw new Error("deletion review queue does not match canonical grouping");
  }
  const expectedPairs = new Set<string>();
  for (const rule of enabledRules) {
    const direct = messages.filter((message) =>
      deletionRuleMatches(message, rule, candidateKinds),
    );
    const selected =
      rule.scope === "thread"
        ? messages.filter((message) =>
            direct.some(
              (match) =>
                match.platform === message.platform &&
                match.accountId === message.accountId &&
                match.threadId === message.threadId,
            ),
          )
        : direct;
    const ruleHash = sha256(rule.id);
    for (const message of selected)
      expectedPairs.add(`${ruleHash}\0${message.id}`);
  }
  const coveredPairs = new Set<string>();
  for (const group of queue.groups) {
    const sortedMessageIds = [...group.messageIds].sort();
    const sortedRuleHashes = [...group.ruleIdHashes].sort();
    const expectedGroupId = sha256(
      canonicalJson({
        scope: group.scope,
        platform: group.platform,
        messageIds: sortedMessageIds,
        ruleIdHashes: sortedRuleHashes,
      }),
    );
    if (group.groupId !== expectedGroupId) {
      throw new Error(
        `deletion review group ${group.groupId} has an invalid id`,
      );
    }
    if (group.scope === "message" && group.messageIds.length !== 1) {
      throw new Error("message-scoped deletion review group is not atomic");
    }
    const groupRules = group.ruleIdHashes.map((ruleHash) => {
      const rule = ruleByHash.get(ruleHash);
      if (!rule) {
        throw new Error(
          `deletion review group ${group.groupId} has an unknown rule`,
        );
      }
      return rule;
    });
    const expectedMatchClasses = [
      ...new Set(groupRules.map((rule) => rule.match.type)),
    ].sort();
    if (
      canonicalJson([...group.matchClasses].sort()) !==
      canonicalJson(expectedMatchClasses)
    ) {
      throw new Error(
        `deletion review group ${group.groupId} has invalid match classes`,
      );
    }
    if (groupRules.some((rule) => rule.scope === "thread")) {
      if (group.scope !== "thread") {
        throw new Error("thread deletion rule is not grouped atomically");
      }
      const first = messagesById.get(group.messageIds[0]);
      const completeThread = messages
        .filter(
          (message) =>
            first &&
            message.platform === first.platform &&
            message.accountId === first.accountId &&
            message.threadId === first.threadId,
        )
        .map((message) => message.id)
        .sort();
      if (canonicalJson(sortedMessageIds) !== canonicalJson(completeThread)) {
        throw new Error("thread deletion review group is incomplete");
      }
    }
    for (const messageId of group.messageIds) {
      const message = messagesById.get(messageId);
      if (!message || message.platform !== group.platform) {
        throw new Error(
          `deletion review group ${group.groupId} has invalid membership`,
        );
      }
      let memberMatched = false;
      for (const ruleHash of group.ruleIdHashes) {
        const pair = `${ruleHash}\0${messageId}`;
        if (expectedPairs.has(pair)) {
          memberMatched = true;
          coveredPairs.add(pair);
        }
      }
      if (!memberMatched) {
        throw new Error(
          `deletion review group ${group.groupId} contains an unmatched message`,
        );
      }
    }
  }
  if (
    expectedPairs.size !== coveredPairs.size ||
    [...expectedPairs].some((pair) => !coveredPairs.has(pair))
  ) {
    throw new Error("deletion review queue does not match rules and corpus");
  }
}

function ledgerFindings(
  messages: readonly CorpusMessage[],
  deletionInputMessages: readonly CorpusMessage[],
  ledger: readonly z.infer<typeof ledgerRecordSchema>[],
  deletionApproval: z.infer<typeof deletionApprovalSchema>,
  approvedDeletionGroups: ReadonlyMap<
    string,
    { scope: "message" | "thread"; ruleIdHashes: readonly string[] }
  >,
  rulesetVersion: string,
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const current = ledger.filter(
    (record) => record.rulesetVersion === rulesetVersion,
  );
  const byMarker = new Map<string, z.infer<typeof ledgerRecordSchema>>();
  for (const record of current) {
    const expectedMarker = [
      `pii:${record.inputHash}:v${record.rulesetVersion}`,
      record.stage,
      record.stageVersion,
    ].join(":");
    if (record.markerKey !== expectedMarker) {
      findings.push({
        kind: "ledger",
        detector: "invalid-marker-key",
        messageId: record.messageId,
        valueHash: findingHash("invalid-marker-key", record.markerKey),
      });
    }
    const approvedDeletionRecord =
      record.stage === "delete" &&
      record.stageVersion === deletionApproval.deleteStageVersion;
    const hasDeletionBinding =
      record.rulesSha256 !== undefined &&
      record.reviewedQueueSha256 !== undefined &&
      record.reviewDecisionSha256 !== undefined;
    const hasTombstoneMetadata =
      hasDeletionBinding &&
      record.ruleIdHashes !== undefined &&
      record.scope !== undefined;
    if (
      approvedDeletionRecord &&
      (!hasDeletionBinding || (record.tombstone && !hasTombstoneMetadata))
    ) {
      findings.push({
        kind: "ledger",
        detector: "missing-deletion-metadata",
        messageId: record.messageId,
        valueHash: findingHash("missing-deletion-metadata", record.markerKey),
      });
    }
    if (
      approvedDeletionRecord &&
      hasDeletionBinding &&
      (record.rulesSha256 !== deletionApproval.rulesSha256 ||
        record.reviewedQueueSha256 !== deletionApproval.reviewedQueueSha256 ||
        record.reviewDecisionSha256 !== deletionApproval.reviewDecisionSha256)
    ) {
      findings.push({
        kind: "ledger",
        detector: "deletion-metadata-binding",
        messageId: record.messageId,
        valueHash: findingHash("deletion-metadata-binding", record.markerKey),
      });
    }
    const expectedOutputHash = record.tombstone
      ? hasTombstoneMetadata
        ? sha256(
            canonicalJson({
              tombstone: true,
              messageId: record.messageId,
              stage: record.stage,
              stageVersion: record.stageVersion,
              rulesSha256: record.rulesSha256,
              reviewedQueueSha256: record.reviewedQueueSha256,
              reviewDecisionSha256: record.reviewDecisionSha256,
              ruleIdHashes: record.ruleIdHashes,
              scope: record.scope,
            }),
          )
        : sha256(canonicalJson({ tombstone: true }))
      : record.output
        ? sha256(JSON.stringify(record.output))
        : undefined;
    if (
      expectedOutputHash === undefined ||
      expectedOutputHash !== record.outputHash ||
      (record.tombstone && record.output !== undefined)
    ) {
      findings.push({
        kind: "ledger",
        detector: "invalid-output-hash",
        messageId: record.messageId,
        valueHash: findingHash("invalid-output-hash", record.markerKey),
      });
    }
    const existing = byMarker.get(record.markerKey);
    if (existing && canonicalJson(existing) !== canonicalJson(record)) {
      findings.push({
        kind: "ledger",
        detector: "conflicting-marker",
        messageId: record.messageId,
        valueHash: findingHash("conflicting-marker", record.markerKey),
      });
    }
    byMarker.set(record.markerKey, record);
  }
  const approvedTombstones = current.filter(
    (record) =>
      record.stage === "delete" &&
      record.stageVersion === deletionApproval.deleteStageVersion &&
      record.tombstone,
  );
  const tombstoned = new Set(
    approvedTombstones.map((record) => record.messageId),
  );
  if (approvedTombstones.length !== tombstoned.size) {
    findings.push({
      kind: "ledger",
      detector: "ambiguous-deletion-tombstone",
      valueHash: findingHash(
        "ambiguous-deletion-tombstone",
        deletionApproval.deleteStageVersion,
      ),
    });
  }
  for (const tombstone of approvedTombstones) {
    const approvedGroup = approvedDeletionGroups.get(tombstone.messageId);
    if (
      !approvedGroup ||
      tombstone.scope !== approvedGroup.scope ||
      canonicalJson(tombstone.ruleIdHashes) !==
        canonicalJson(approvedGroup.ruleIdHashes)
    ) {
      findings.push({
        kind: "ledger",
        detector: "deletion-tombstone-review-binding",
        messageId: tombstone.messageId,
        valueHash: findingHash(
          "deletion-tombstone-review-binding",
          tombstone.markerKey,
        ),
      });
    }
    const secretsRecords = current.filter(
      (record) =>
        record.messageId === tombstone.messageId &&
        record.stage === "secrets" &&
        !record.tombstone &&
        record.outputHash === tombstone.inputHash,
    );
    const mineRecords =
      secretsRecords.length === 1
        ? current.filter(
            (record) =>
              record.messageId === tombstone.messageId &&
              record.stage === "mine" &&
              !record.tombstone &&
              record.outputHash === secretsRecords[0].inputHash,
          )
        : [];
    if (secretsRecords.length !== 1 || mineRecords.length !== 1) {
      findings.push({
        kind: "ledger",
        detector: "broken-tombstone-chain",
        messageId: tombstone.messageId,
        valueHash: findingHash("broken-tombstone-chain", tombstone.markerKey),
      });
    }
  }
  const tombstoneIds = [...tombstoned].sort();
  if (
    sha256(canonicalJson(tombstoneIds)) !== deletionApproval.tombstoneIdsSha256
  ) {
    findings.push({
      kind: "ledger",
      detector: "deletion-tombstone-set",
      valueHash: findingHash(
        "deletion-tombstone-set",
        canonicalJson(tombstoneIds),
      ),
    });
  }
  const deletionInputIds = deletionInputMessages.map((message) => message.id);
  const liveIds = messages.map((message) => message.id);
  const partitionIds = [...liveIds, ...tombstoneIds].sort();
  if (
    new Set(deletionInputIds).size !== deletionInputIds.length ||
    new Set(liveIds).size !== liveIds.length ||
    liveIds.some((messageId) => tombstoned.has(messageId)) ||
    canonicalJson([...deletionInputIds].sort()) !== canonicalJson(partitionIds)
  ) {
    findings.push({
      kind: "ledger",
      detector: "deletion-input-partition",
      valueHash: findingHash(
        "deletion-input-partition",
        canonicalJson({
          deletionInputIds: [...deletionInputIds].sort(),
          partitionIds,
        }),
      ),
    });
  }
  if (messages.length !== deletionApproval.survivorCount) {
    findings.push({
      kind: "ledger",
      detector: "deletion-survivor-count",
      valueHash: findingHash(
        "deletion-survivor-count",
        `${messages.length}:${deletionApproval.survivorCount}`,
      ),
    });
  }
  const attachmentBytesDropped = droppedAttachmentByteCount(
    deletionInputMessages,
  );
  if (attachmentBytesDropped !== deletionApproval.attachmentBytesDropped) {
    findings.push({
      kind: "ledger",
      detector: "deletion-attachment-drop-count",
      valueHash: findingHash(
        "deletion-attachment-drop-count",
        `${attachmentBytesDropped}:${deletionApproval.attachmentBytesDropped}`,
      ),
    });
  }
  const deletionInputsById = new Map(
    deletionInputMessages.map((message) => [message.id, message]),
  );
  for (const message of messages) {
    if (tombstoned.has(message.id)) {
      findings.push({
        kind: "ledger",
        detector: "tombstone-live-conflict",
        messageId: message.id,
        valueHash: findingHash("tombstone-live-conflict", message.id),
      });
    }
    const messageHash = sha256(JSON.stringify(message));
    const terminals = current.filter(
      (record) =>
        record.messageId === message.id &&
        record.stage === "llm" &&
        !record.tombstone &&
        record.outputHash === messageHash &&
        record.output !== undefined &&
        canonicalJson(record.output) === canonicalJson(message),
    );
    if (terminals.length !== 1) {
      findings.push({
        kind: "ledger",
        detector:
          terminals.length === 0
            ? "missing-terminal-coverage"
            : "ambiguous-terminal-coverage",
        messageId: message.id,
        valueHash: findingHash("terminal-coverage", message.id),
      });
      continue;
    }
    let downstream = terminals[0];
    for (const expectedStage of [
      "rewrite",
      "delete",
      "secrets",
      "mine",
    ] as const) {
      const predecessors = current.filter(
        (record) =>
          record.messageId === message.id &&
          record.stage === expectedStage &&
          !record.tombstone &&
          record.outputHash === downstream.inputHash &&
          (expectedStage !== "delete" ||
            record.stageVersion === deletionApproval.deleteStageVersion),
      );
      if (predecessors.length !== 1) {
        findings.push({
          kind: "ledger",
          detector:
            predecessors.length === 0
              ? "broken-stage-chain"
              : "ambiguous-stage-chain",
          messageId: message.id,
          valueHash: findingHash("stage-chain", downstream.markerKey),
        });
        break;
      }
      if (expectedStage === "delete") {
        const source = deletionInputsById.get(message.id);
        const expectedOutput = source
          ? {
              ...source,
              attachments: source.attachments.map((attachment) => ({
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                sha256: attachment.sha256,
              })),
            }
          : undefined;
        const deleteRecord = predecessors[0];
        if (
          !source ||
          !expectedOutput ||
          deleteRecord.inputHash !== sha256(JSON.stringify(source)) ||
          deleteRecord.outputHash !== sha256(JSON.stringify(expectedOutput)) ||
          deleteRecord.output === undefined ||
          canonicalJson(deleteRecord.output) !== canonicalJson(expectedOutput)
        ) {
          findings.push({
            kind: "ledger",
            detector: "invalid-deletion-survivor-transform",
            messageId: message.id,
            valueHash: findingHash(
              "invalid-deletion-survivor-transform",
              deleteRecord.markerKey,
            ),
          });
        }
      }
      downstream = predecessors[0];
    }
  }
  if (tombstoned.size !== deletionApproval.tombstoneCount) {
    findings.push({
      kind: "ledger",
      detector: "deletion-tombstone-count",
      valueHash: findingHash(
        "deletion-tombstone-count",
        `${tombstoned.size}:${deletionApproval.tombstoneCount}`,
      ),
    });
  }
  return findings;
}

function dedupeFindings(
  findings: readonly VerificationFinding[],
): VerificationFinding[] {
  return [
    ...new Map(
      findings.map((finding) => [JSON.stringify(finding), finding]),
    ).values(),
  ].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      (a.messageId ?? "").localeCompare(b.messageId ?? "") ||
      a.valueHash.localeCompare(b.valueHash),
  );
}

export async function verifyCorpus(
  options: VerifyCorpusOptions,
): Promise<CorpusVerificationReport> {
  const gitleaksConfigPath = path.resolve(
    options.gitleaksConfigPath ??
      path.resolve(import.meta.dirname, "../../../.gitleaks.toml"),
  );
  const initialInputHashes = await verificationInputHashes(
    options,
    gitleaksConfigPath,
  );
  const shardPaths = (await findCorpusShardFiles(options.targetPath)).filter(
    (file) => !file.split(path.sep).includes(".state"),
  );
  if (shardPaths.length === 0)
    throw new Error("verification target has no corpus shards");
  const snapshots = await Promise.all(
    shardPaths.map(async (shardPath) => ({
      path: shardPath,
      bytes: await fs.readFile(shardPath),
    })),
  );
  const { messages, manifestShards } = await readMessages(
    options.targetPath,
    snapshots,
  );
  await validateManifestSnapshots(options.manifestPath, manifestShards);
  const corpusDigest = digestSnapshots(options.targetPath, snapshots);
  const candidates = await readJsonLines(
    options.candidatesPath,
    candidateSchema,
  );
  if (candidates.length === 0) {
    throw new Error(
      "verification requires the complete mine candidate artifact",
    );
  }
  for (const candidate of candidates) {
    const expected = sha256(
      `${options.rulesetVersion}\0${candidate.surfaceForm}`,
    );
    if (candidate.valueHash !== expected) {
      throw new Error(
        `candidate value hash is invalid for message ${candidate.msgId}`,
      );
    }
  }
  const deletionCandidatesDigest = sha256(
    canonicalJson(
      candidates
        .map((candidate) => ({ msgId: candidate.msgId, kind: candidate.kind }))
        .sort(
          (left, right) =>
            left.msgId.localeCompare(right.msgId) ||
            left.kind.localeCompare(right.kind),
        ),
    ),
  );
  const canaryRaw = JSON.parse(await fs.readFile(options.canariesPath, "utf8"));
  const canaries = canaryManifestSchema.parse(canaryRaw);
  if (canaries.rulesetVersion !== options.rulesetVersion) {
    throw new Error(
      `canary ruleset ${canaries.rulesetVersion} does not match ${options.rulesetVersion}`,
    );
  }
  const ledger = await readJsonLines(options.ledgerPath, ledgerRecordSchema);
  const uniqueStageRecords = new Set<string>();
  for (const record of ledger.filter(
    (candidate) =>
      candidate.rulesetVersion === options.rulesetVersion &&
      candidate.stage !== "delete",
  )) {
    const key = `${record.messageId}\0${record.stage}`;
    if (uniqueStageRecords.has(key)) {
      throw new Error(
        `ambiguous ${record.stage} ledger history for message ${record.messageId}`,
      );
    }
    uniqueStageRecords.add(key);
  }
  const currentMineStageRecords = ledger.filter(
    (record) =>
      record.rulesetVersion === options.rulesetVersion &&
      record.stage === "mine",
  );
  const currentSecretsStageRecords = ledger.filter(
    (record) =>
      record.rulesetVersion === options.rulesetVersion &&
      record.stage === "secrets",
  );
  const mineByMessageId = new Map(
    currentMineStageRecords.map((record) => [record.messageId, record]),
  );
  const secretsByMessageId = new Map(
    currentSecretsStageRecords.map((record) => [record.messageId, record]),
  );
  if (
    currentSecretsStageRecords.some((secretsRecord) => {
      const mineRecord = mineByMessageId.get(secretsRecord.messageId);
      return (
        !mineRecord ||
        mineRecord.tombstone ||
        secretsRecord.inputHash !== mineRecord.outputHash
      );
    }) ||
    currentMineStageRecords.some((mineRecord) => {
      const secretsRecord = secretsByMessageId.get(mineRecord.messageId);
      return mineRecord.tombstone
        ? secretsRecord !== undefined
        : !secretsRecord || secretsRecord.inputHash !== mineRecord.outputHash;
    })
  ) {
    throw new Error("mine and secrets ledger stages do not match exactly");
  }
  const currentMineRecords = currentMineStageRecords.filter(
    (record) => !record.tombstone && record.output,
  );
  const mineOutputs = new Map(
    currentMineRecords.map((record) => [record.messageId, record.output]),
  );
  for (const candidate of candidates) {
    const source = mineOutputs.get(candidate.msgId);
    const { start, end } = candidate.sourceRef.span;
    if (
      !source ||
      candidate.sourceRef.memoryId !== candidate.msgId ||
      candidate.sourceRef.threadId !== source.threadId ||
      candidate.sourceRef.platform !== source.platform ||
      candidate.sourceRef.accountId !== source.accountId ||
      start >= end ||
      source.text.slice(start, end) !== candidate.surfaceForm
    ) {
      throw new Error(
        `candidate source reference is invalid for message ${candidate.msgId}`,
      );
    }
  }
  const mineMessages = [...mineOutputs.values()].filter(
    (message): message is CorpusMessage => message !== undefined,
  );
  const rerunMine = await minePiiCandidates(mineMessages, {
    hashSalt: options.rulesetVersion,
  });
  const candidateKey = (candidate: (typeof candidates)[number]): string =>
    `${candidate.msgId}\0${candidate.kind}\0${candidate.sourceRef.span.start}\0${candidate.sourceRef.span.end}\0${candidate.valueHash}`;
  const suppliedCandidateKeys = candidates.map(candidateKey).sort();
  const expectedCandidateKeys = rerunMine.candidates.map(candidateKey).sort();
  if (
    canonicalJson(suppliedCandidateKeys) !==
    canonicalJson(expectedCandidateKeys)
  ) {
    throw new Error(
      "mine candidate artifact does not exactly match mining rerun",
    );
  }
  const deletionApproval = deletionApprovalSchema.parse(
    JSON.parse(await fs.readFile(options.deletionApprovalPath, "utf8")),
  );
  const deletionRules = deletionRulesArtifactSchema.parse(
    JSON.parse(await fs.readFile(options.deletionRulesPath, "utf8")),
  );
  const deletionReviewQueue = deletionReviewQueueSchema.parse(
    JSON.parse(await fs.readFile(options.deletionReviewQueuePath, "utf8")),
  );
  const deletionReviewDecision = deletionReviewDecisionSchema.parse(
    JSON.parse(await fs.readFile(options.deletionReviewDecisionPath, "utf8")),
  );
  if (
    new Set(deletionRules.rules.map((rule) => rule.id)).size !==
    deletionRules.rules.length
  ) {
    throw new Error("deletion rules contain duplicate ids");
  }
  const deletionInputMessages = ledger
    .filter(
      (record) =>
        record.rulesetVersion === options.rulesetVersion &&
        record.stage === "secrets" &&
        !record.tombstone &&
        record.output,
    )
    .map((record) => record.output)
    .filter((message): message is CorpusMessage => message !== undefined);
  const deletionInputDigest = sha256(
    canonicalJson(
      [...deletionInputMessages].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    ),
  );
  const normalizedDeletionRules = {
    ...deletionRules,
    rules: [...deletionRules.rules].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  const rulesDigest = sha256(canonicalJson(normalizedDeletionRules));
  const queueDigest = sha256(canonicalJson(deletionReviewQueue));
  const decisionDigest = sha256(canonicalJson(deletionReviewDecision));
  const deletionBindings = [
    ["corpus", deletionApproval.corpusDigest, deletionInputDigest],
    ["candidates", deletionApproval.candidatesSha256, deletionCandidatesDigest],
    ["deletion rules", deletionApproval.rulesSha256, rulesDigest],
    [
      "deletion review queue",
      deletionApproval.reviewedQueueSha256,
      queueDigest,
    ],
    [
      "deletion review decision",
      deletionApproval.reviewDecisionSha256,
      decisionDigest,
    ],
    ["queue corpus", deletionReviewQueue.corpusDigest, deletionInputDigest],
    ["queue rules", deletionReviewQueue.rulesSha256, rulesDigest],
    [
      "queue candidates",
      deletionReviewQueue.candidatesSha256,
      deletionCandidatesDigest,
    ],
    [
      "decision corpus",
      deletionReviewDecision.corpusDigest,
      deletionInputDigest,
    ],
    ["decision rules", deletionReviewDecision.rulesSha256, rulesDigest],
    ["decision queue", deletionReviewDecision.reviewedQueueSha256, queueDigest],
  ] as const;
  for (const [name, claimed, actual] of deletionBindings) {
    if (claimed !== actual) {
      throw new Error(`${name} digest does not match deletion approval`);
    }
  }
  const expectedDeleteStageVersion = `delete-v1:${rulesDigest.slice(0, 12)}:${queueDigest.slice(0, 12)}:${decisionDigest.slice(0, 12)}`;
  if (deletionApproval.deleteStageVersion !== expectedDeleteStageVersion) {
    throw new Error("deletion approval delete stage version is invalid");
  }
  for (const [name, value] of [
    ["deletion rules", deletionRules.rulesetVersion],
    ["deletion queue", deletionReviewQueue.rulesetVersion],
    ["deletion decision", deletionReviewDecision.rulesetVersion],
  ] as const) {
    if (value !== options.rulesetVersion) {
      throw new Error(`${name} ruleset does not match verification ruleset`);
    }
  }
  const groupsById = new Map(
    deletionReviewQueue.groups.map((group) => [group.groupId, group]),
  );
  if (groupsById.size !== deletionReviewQueue.groups.length) {
    throw new Error("deletion review queue contains duplicate group ids");
  }
  for (const group of deletionReviewQueue.groups) {
    if (new Set(group.messageIds).size !== group.messageIds.length) {
      throw new Error(
        `deletion review group ${group.groupId} repeats a message`,
      );
    }
    for (const messageId of group.messageIds) {
      if (!mineOutputs.has(messageId)) {
        throw new Error(
          `deletion review group ${group.groupId} references an unknown message`,
        );
      }
    }
  }
  validateDeletionQueueSemantics(
    deletionInputMessages,
    candidates,
    deletionRules,
    deletionReviewQueue,
  );
  const decisionsById = new Map(
    deletionReviewDecision.decisions.map((decision) => [
      decision.groupId,
      decision.decision,
    ]),
  );
  if (decisionsById.size !== deletionReviewDecision.decisions.length) {
    throw new Error("deletion review decision contains duplicate group ids");
  }
  if (
    [...groupsById.keys()].some((groupId) => !decisionsById.has(groupId)) ||
    [...decisionsById.keys()].some((groupId) => !groupsById.has(groupId))
  ) {
    throw new Error(
      "deletion review decisions are incomplete or contain extras",
    );
  }
  const approvedDeletedIds = [
    ...new Set(
      deletionReviewQueue.groups.flatMap((group) =>
        decisionsById.get(group.groupId) === "delete" ? group.messageIds : [],
      ),
    ),
  ].sort();
  const approvedDeletionGroups = new Map<
    string,
    { scope: "message" | "thread"; ruleIdHashes: readonly string[] }
  >();
  for (const group of deletionReviewQueue.groups) {
    if (decisionsById.get(group.groupId) !== "delete") continue;
    for (const messageId of group.messageIds) {
      if (approvedDeletionGroups.has(messageId)) {
        throw new Error(
          `message ${messageId} belongs to multiple approved deletion groups`,
        );
      }
      approvedDeletionGroups.set(messageId, {
        scope: group.scope,
        ruleIdHashes: group.ruleIdHashes,
      });
    }
  }
  if (
    approvedDeletedIds.length !== deletionApproval.tombstoneCount ||
    sha256(canonicalJson(approvedDeletedIds)) !==
      deletionApproval.tombstoneIdsSha256
  ) {
    throw new Error("deletion approval does not match reviewed deleted ids");
  }
  const placeholderRegistry = placeholderRegistrySchema.parse(
    JSON.parse(await fs.readFile(options.placeholderRegistryPath, "utf8")),
  );
  const registryKeys = new Set<string>();
  for (const entry of placeholderRegistry.entries) {
    const key = `${entry.messageId}\0${entry.placeholder}`;
    if (registryKeys.has(key)) {
      throw new Error(
        `duplicate placeholder registry entry for ${entry.messageId}`,
      );
    }
    registryKeys.add(key);
  }
  for (const [name, ruleset] of [
    ["deletion approval", deletionApproval.rulesetVersion],
    ["placeholder registry", placeholderRegistry.rulesetVersion],
  ] as const) {
    if (ruleset !== options.rulesetVersion) {
      throw new Error(
        `${name} ruleset ${ruleset} does not match ${options.rulesetVersion}`,
      );
    }
  }
  const gazetteerValues = [
    ...new Set([
      ...candidates.map((candidate) => candidate.surfaceForm),
      ...(await readGazetteerValues(options.gazetteerPath)),
    ]),
  ];
  const workDir = await fs.mkdtemp(
    path.join(
      path.dirname(options.reportPath ?? options.targetPath),
      "corpus-verify-",
    ),
  );
  let gitleaks: GitleaksResult;
  try {
    const snapshotPaths: string[] = [];
    for (const [index, snapshot] of snapshots.entries()) {
      const snapshotPath = path.join(workDir, "shards", `${index}.jsonl`);
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, snapshot.bytes, { mode: 0o600 });
      snapshotPaths.push(snapshotPath);
    }
    gitleaks = await (options.gitleaksScanner ?? scanShardsWithGitleaks)(
      snapshotPaths,
      {
        binaryPath: options.gitleaksBinaryPath ?? "gitleaks",
        configPath: gitleaksConfigPath,
        workDir,
      },
    );
  } finally {
    // Scratch may contain raw scanner reports, so deletion failure is fatal.
    await fs.rm(workDir, { recursive: true, force: true });
  }
  const findings = dedupeFindings([
    ...gitleaks.findings,
    ...(await detectorFindings(messages, gazetteerValues)),
    ...originalValueFindings(messages, candidates),
    ...canaryFindings(
      messages,
      canaries,
      ledger,
      deletionApproval,
      new Set(approvedDeletedIds),
    ),
    ...registryFindings(messages, placeholderRegistry, candidates, ledger),
    ...attachmentFindings(messages),
    ...ledgerFindings(
      messages,
      deletionInputMessages,
      ledger,
      deletionApproval,
      approvedDeletionGroups,
      options.rulesetVersion,
    ),
  ]);
  const counts: Record<VerificationFindingKind, number> = {
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
  for (const finding of findings) counts[finding.kind] += 1;
  const finalShardPaths = (
    await findCorpusShardFiles(options.targetPath)
  ).filter((file) => !file.split(path.sep).includes(".state"));
  if (
    canonicalJson([...finalShardPaths].sort()) !==
    canonicalJson([...shardPaths].sort())
  ) {
    throw new Error("corpus shard set changed during verification");
  }
  const currentCorpusDigest = await digestShards(
    options.targetPath,
    finalShardPaths,
  );
  if (currentCorpusDigest !== corpusDigest) {
    throw new Error("corpus shards changed during verification");
  }
  const finalInputHashes = await verificationInputHashes(
    options,
    gitleaksConfigPath,
  );
  for (const key of verificationInputKeys) {
    if (initialInputHashes[key] !== finalInputHashes[key]) {
      throw new Error(`${key} changed during verification`);
    }
  }
  const unsigned: Omit<CorpusVerificationReport, "reportDigest"> = {
    schemaVersion: 1,
    scope: "jsonl-text-v1",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    rulesetVersion: options.rulesetVersion,
    status: findings.length === 0 ? "passed" : "failed",
    corpusDigest,
    shardCount: shardPaths.length,
    messageCount: messages.length,
    candidateCount: candidates.length,
    canaryCount: canaries.canaries.length,
    inputs: finalInputHashes,
    scanner: {
      name: "gitleaks",
      version: gitleaks.version,
      findingCount: gitleaks.findings.length,
    },
    counts,
    findings,
  };
  const report = { ...unsigned, reportDigest: reportDigest(unsigned) };
  if (options.reportPath) {
    await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
    await fs.writeFile(
      options.reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return report;
}

export async function assertFreshGreenVerification(
  report: CorpusVerificationReport,
  options: VerifyCorpusOptions,
): Promise<void> {
  const generatedAt = new Date(report.generatedAt);
  if (Number.isNaN(generatedAt.valueOf())) {
    throw new Error("verification report generatedAt is invalid");
  }
  const fresh = await verifyCorpus({
    ...options,
    reportPath: undefined,
    now: () => generatedAt,
  });
  if (
    fresh.status !== "passed" ||
    fresh.findings.length !== 0 ||
    fresh.scanner.findingCount !== 0
  ) {
    throw new Error("fresh verification is not green");
  }
  if (canonicalJson(fresh) !== canonicalJson(report)) {
    throw new Error("verification report does not match a fresh verification");
  }
}
