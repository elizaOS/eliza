/**
 * JSONL shard and manifest validation for corpus imports. The validator is
 * deliberately pure at the row level and filesystem-bound only at the shard
 * boundary so tests can exercise schema logic without fixtures while the CLI
 * verifies real files, hashes, and path-derived platform/account/month layout.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CORPUS_ANCHOR_MS,
  CORPUS_CUTOFF_ISO,
  type CorpusManifest,
  type CorpusMessage,
  type CorpusPlatform,
  type CorpusShardManifestEntry,
  corpusManifestSchema,
  corpusMessageSchema,
  corpusPlatforms,
} from "./schema.ts";

export interface CorpusValidationIssue {
  path?: string;
  line?: number;
  code:
    | "schema-invalid"
    | "cutoff-window"
    | "duplicate-id"
    | "reply-missing"
    | "thread-mismatch"
    | "path-mismatch"
    | "manifest-invalid"
    | "manifest-mismatch"
    | "empty-shard";
  message: string;
}

export interface CorpusValidationResult {
  ok: boolean;
  messages: CorpusMessage[];
  issues: CorpusValidationIssue[];
}

export interface ShardReadResult {
  path: string;
  messages: CorpusMessage[];
  sha256: string;
  issues: CorpusValidationIssue[];
}

export interface CorpusValidationOptions {
  maxTs?: number;
  rootDir?: string;
}

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCorpusPlatform(value: string | undefined): value is CorpusPlatform {
  return corpusPlatforms.some((platform) => platform === value);
}

function parseShardPath(filePath: string, rootDir?: string) {
  const relative = rootDir
    ? path.relative(rootDir, filePath)
    : path.relative(process.cwd(), filePath);
  const parts = relative.split(path.sep);
  const filename = parts.at(-1);
  if (!filename) {
    return { relative: relative.split(path.sep).join("/") };
  }
  const accountId = parts.at(-2);
  const maybePlatform = parts.at(-3);
  const platform = isCorpusPlatform(maybePlatform) ? maybePlatform : undefined;
  const month = filename.replace(/\.jsonl$/, "");
  return {
    relative: relative.split(path.sep).join("/"),
    platform,
    accountId,
    month,
  };
}

function validateMessages(
  messages: CorpusMessage[],
  options: CorpusValidationOptions = {},
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  const ids = new Set<string>();
  const maxTs = options.maxTs ?? CORPUS_ANCHOR_MS;

  for (const message of messages) {
    if (ids.has(message.id)) {
      issues.push({
        code: "duplicate-id",
        message: `duplicate message id ${message.id}`,
      });
    }
    ids.add(message.id);
    if (message.ts > maxTs) {
      issues.push({
        code: "cutoff-window",
        message: `message ${message.id} is after corpus anchor`,
      });
    }
  }

  for (const message of messages) {
    if (message.replyToId && !ids.has(message.replyToId)) {
      issues.push({
        code: "reply-missing",
        message: `message ${message.id} replies to missing ${message.replyToId}`,
      });
    }
  }

  return issues;
}

export function validateCorpusMessages(
  input: unknown[],
  options: CorpusValidationOptions = {},
): CorpusValidationResult {
  const messages: CorpusMessage[] = [];
  const issues: CorpusValidationIssue[] = [];

  input.forEach((row, index) => {
    const parsed = corpusMessageSchema.safeParse(row);
    if (parsed.success) {
      messages.push(parsed.data);
    } else {
      issues.push({
        line: index + 1,
        code: "schema-invalid",
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    }
  });

  issues.push(...validateMessages(messages, options));
  return { ok: issues.length === 0, messages, issues };
}

export async function readCorpusShard(
  filePath: string,
  options: CorpusValidationOptions = {},
): Promise<ShardReadResult> {
  const raw = await fs.readFile(filePath, "utf8");
  const rows: unknown[] = [];
  const issues: CorpusValidationIssue[] = [];
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    issues.push({
      path: filePath,
      code: "empty-shard",
      message: "shard contains no JSONL rows",
    });
  }

  lines.forEach((line, index) => {
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      // error-policy:J3 JSONL rows are untrusted corpus input; report invalid row.
      issues.push({
        path: filePath,
        line: index + 1,
        code: "schema-invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const result = validateCorpusMessages(rows, options);
  const pathInfo = parseShardPath(filePath, options.rootDir);
  for (const message of result.messages) {
    if (
      message.platform !== pathInfo.platform ||
      message.accountId !== pathInfo.accountId ||
      new Date(message.ts).toISOString().slice(0, 7) !== pathInfo.month
    ) {
      result.issues.push({
        path: filePath,
        code: "path-mismatch",
        message: `message ${message.id} does not match shard path ${pathInfo.relative}`,
      });
    }
  }

  return {
    path: filePath,
    messages: result.messages,
    sha256: sha256(raw),
    issues: [...issues, ...result.issues],
  };
}

export async function findCorpusShardFiles(
  targetPath: string,
): Promise<string[]> {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) return [targetPath];

  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(entryPath);
      }
    }
  }
  await walk(targetPath);
  return found.sort();
}

export async function buildCorpusManifest(
  targetPath: string,
  generatedAt = new Date().toISOString(),
): Promise<{ manifest: CorpusManifest; issues: CorpusValidationIssue[] }> {
  const rootDir = (await fs.stat(targetPath)).isDirectory()
    ? targetPath
    : path.dirname(targetPath);
  const shardFiles = await findCorpusShardFiles(targetPath);
  const entries: CorpusShardManifestEntry[] = [];
  const issues: CorpusValidationIssue[] = [];

  for (const file of shardFiles) {
    const shard = await readCorpusShard(file, { rootDir });
    issues.push(...shard.issues);
    const pathInfo = parseShardPath(file, rootDir);
    if (!pathInfo.platform || !pathInfo.accountId || !pathInfo.month) {
      issues.push({
        path: file,
        code: "path-mismatch",
        message: `shard path must be <platform>/<account>/<yyyy-mm>.jsonl`,
      });
      continue;
    }
    if (shard.messages.length === 0) continue;
    const sortedTs = shard.messages
      .map((message) => message.ts)
      .sort((a, b) => a - b);
    entries.push({
      path: pathInfo.relative,
      platform: pathInfo.platform,
      accountId: pathInfo.accountId,
      month: pathInfo.month,
      count: shard.messages.length,
      firstTs: sortedTs[0],
      lastTs: sortedTs[sortedTs.length - 1],
      sha256: shard.sha256,
    });
  }

  const manifest = corpusManifestSchema.parse({
    schemaVersion: 1,
    generatedAt,
    cutoffIso: CORPUS_CUTOFF_ISO,
    shards: entries,
    totals: {
      messages: entries.reduce((sum, entry) => sum + entry.count, 0),
      contacts: 0,
      threads: 0,
    },
  });
  return { manifest, issues };
}

export async function validateCorpusTarget(targetPath: string): Promise<{
  ok: boolean;
  manifest: CorpusManifest;
  issues: CorpusValidationIssue[];
}> {
  const { manifest, issues } = await buildCorpusManifest(targetPath);
  const parsed = corpusManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    issues.push({
      code: "manifest-invalid",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
  }
  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetPath);
    if (entries.includes("manifest.json")) {
      const manifestPath = path.join(targetPath, "manifest.json");
      const expected = corpusManifestSchema.safeParse(
        JSON.parse(await fs.readFile(manifestPath, "utf8")),
      );
      if (!expected.success) {
        issues.push({
          path: manifestPath,
          code: "manifest-invalid",
          message: expected.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
      } else if (
        JSON.stringify({
          cutoffIso: expected.data.cutoffIso,
          shards: expected.data.shards,
          totals: expected.data.totals,
        }) !==
        JSON.stringify({
          cutoffIso: manifest.cutoffIso,
          shards: manifest.shards,
          totals: manifest.totals,
        })
      ) {
        issues.push({
          path: manifestPath,
          code: "manifest-mismatch",
          message: "manifest.json does not match shard contents",
        });
      }
    }
  }
  return { ok: issues.length === 0, manifest, issues };
}
