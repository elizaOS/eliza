/**
 * Reads and writes scoped legacy foreground-shell artifacts without exposing
 * their state-root paths. Current SHELL runs return accepted output directly;
 * this compatibility store keeps already-issued handles readable until expiry.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, resolveStateDir, toWellFormedUnicode } from "@elizaos/core";
import { resolveShellJobTtlMs } from "../shell/utils/config.js";

const ARTIFACT_ROOT_SEGMENTS = ["coding-tools", "shell-output"] as const;
const ARTIFACT_PREFIX = "shell_";

export interface ShellStreamMetrics {
  characters: number;
  bytes: number;
  lines: number;
}

export interface ShellOutputArtifact {
  handle: string;
  manifestPath: string;
  stdoutPath: string;
  stderrPath: string;
  createdAt: string;
  expiresAt: string;
  retentionMs: number;
  stdout: ShellStreamMetrics;
  stderr: ShellStreamMetrics;
}

interface PersistShellOutputArtifactOptions {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  modelCharacterLimit: number;
  modelCharacters: number;
  ownerAgentId: string;
  ownerConversationId: string;
}

export type ShellOutputArtifactStream = "stdout" | "stderr";

export interface ShellOutputArtifactPage {
  handle: string;
  stream: ShellOutputArtifactStream;
  text: string;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
  totalCharacters: number;
  complete: boolean;
  createdAt: string;
  expiresAt: string;
}

export type ShellOutputArtifactReadResult =
  | { ok: true; value: ShellOutputArtifactPage }
  | {
      ok: false;
      reason: "invalid_handle" | "unavailable" | "expired" | "corrupt";
      message: string;
    };

const ARTIFACT_HANDLE_PATTERN =
  /^shell_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACT_PAGE_DEFAULT_CHARS = 12_000;
const ARTIFACT_PAGE_MAX_CHARS = 20_000;

interface PersistedShellOutputManifest {
  version: 1;
  handle: string;
  createdAt: string;
  expiresAt: string;
  owner: { agentId: string; conversationId: string };
}

async function readRegularUtf8(filePath: string): Promise<string> {
  const file = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("artifact entry is not a regular file");
    return await file.readFile({ encoding: "utf8" });
  } finally {
    await file.close();
  }
}

function normalizePageStart(text: string, requested: number): number {
  let start = Math.max(0, Math.min(text.length, Math.floor(requested)));
  if (
    start > 0 &&
    start < text.length &&
    text.charCodeAt(start) >= 0xdc00 &&
    text.charCodeAt(start) <= 0xdfff &&
    text.charCodeAt(start - 1) >= 0xd800 &&
    text.charCodeAt(start - 1) <= 0xdbff
  ) {
    start -= 1;
  }
  return start;
}

function normalizePageEnd(text: string, start: number, limit: number): number {
  let end = Math.min(text.length, start + limit);
  if (
    end > start &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  if (end === start && start < text.length) {
    end = Math.min(text.length, start + 2);
  }
  return end;
}

function streamMetrics(text: string): ShellStreamMetrics {
  const newlineCount = text.match(/\n/g)?.length ?? 0;
  return {
    characters: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: text.length === 0 ? 0 : newlineCount + (text.endsWith("\n") ? 0 : 1),
  };
}

async function sweepExpiredArtifacts(
  root: string,
  cutoffMs: number,
): Promise<void> {
  try {
    const entries = await fs.readdir(root, {
      encoding: "utf8",
      withFileTypes: true,
    });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith(ARTIFACT_PREFIX)) {
          return;
        }
        const artifactPath = path.join(root, entry.name);
        try {
          const stat = await fs.stat(artifactPath);
          if (stat.mtimeMs < cutoffMs) {
            await fs.rm(artifactPath, { recursive: true, force: true });
          }
        } catch (error) {
          // error-policy:J6 concurrent expiry/removal is harmless teardown.
          logger.warn(
            { artifactPath, error },
            "[CodingTools] Failed to expire shell-output artifact",
          );
        }
      }),
    );
  } catch (error) {
    // error-policy:J6 artifact expiry is best-effort teardown; persistence of
    // the new artifact remains authoritative and the failed sweep is visible.
    logger.warn(
      { error },
      "[CodingTools] Failed to inspect expired shell-output artifacts",
    );
  }
}

/** Persist one complete, already-redacted foreground shell result. */
export async function persistShellOutputArtifact(
  options: PersistShellOutputArtifactOptions,
): Promise<ShellOutputArtifact> {
  const retentionMs = resolveShellJobTtlMs();
  const createdAtMs = Date.now();
  const root = path.join(resolveStateDir(), ...ARTIFACT_ROOT_SEGMENTS);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await sweepExpiredArtifacts(root, createdAtMs - retentionMs);

  const handle = `${ARTIFACT_PREFIX}${randomUUID()}`;
  const artifactDirectory = path.join(root, handle);
  await fs.mkdir(artifactDirectory, { mode: 0o700 });
  const stdoutPath = path.join(artifactDirectory, "stdout.txt");
  const stderrPath = path.join(artifactDirectory, "stderr.txt");
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  const stdout = streamMetrics(options.stdout);
  const stderr = streamMetrics(options.stderr);
  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + retentionMs).toISOString();

  await Promise.all([
    fs.writeFile(stdoutPath, options.stdout, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
    fs.writeFile(stderrPath, options.stderr, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  const artifact: ShellOutputArtifact = {
    handle,
    manifestPath,
    stdoutPath,
    stderrPath,
    createdAt,
    expiresAt,
    retentionMs,
    stdout,
    stderr,
  };
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        handle,
        createdAt,
        expiresAt,
        owner: {
          agentId: options.ownerAgentId,
          conversationId: options.ownerConversationId,
        },
        command: options.command,
        cwd: options.cwd,
        exitCode: options.exitCode,
        timedOut: options.timedOut,
        signal: options.signal,
        stdout: { path: stdoutPath, ...stdout },
        stderr: { path: stderrPath, ...stderr },
        truncation: {
          modelCharacterLimit: options.modelCharacterLimit,
          modelCharacters: options.modelCharacters,
          completeCharacters: options.stdout.length + options.stderr.length,
          completeBytes: stdout.bytes + stderr.bytes,
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return artifact;
}

/**
 * Resolve one bounded artifact page by opaque handle. The state-root path is
 * never accepted from the caller, and the persisted agent/conversation scope
 * must match the requesting action turn before any stream bytes are returned.
 */
export async function readShellOutputArtifactPage(options: {
  handle: string;
  stream: ShellOutputArtifactStream;
  offset?: number;
  limit?: number;
  requesterAgentId: string;
  requesterConversationId: string;
}): Promise<ShellOutputArtifactReadResult> {
  if (!ARTIFACT_HANDLE_PATTERN.test(options.handle)) {
    return {
      ok: false,
      reason: "invalid_handle",
      message: "invalid shell-output artifact handle",
    };
  }

  const root = path.join(resolveStateDir(), ...ARTIFACT_ROOT_SEGMENTS);
  const artifactDirectory = path.join(root, options.handle);
  try {
    const [realRoot, realArtifactDirectory] = await Promise.all([
      fs.realpath(root),
      fs.realpath(artifactDirectory),
    ]);
    if (path.dirname(realArtifactDirectory) !== realRoot) {
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    }

    const manifestRaw = await readRegularUtf8(
      path.join(realArtifactDirectory, "manifest.json"),
    );
    const parsed: unknown = JSON.parse(manifestRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("artifact manifest is not an object");
    }
    const manifest = parsed as Partial<PersistedShellOutputManifest>;
    if (
      manifest.version !== 1 ||
      manifest.handle !== options.handle ||
      typeof manifest.createdAt !== "string" ||
      typeof manifest.expiresAt !== "string" ||
      !manifest.owner ||
      manifest.owner.agentId !== options.requesterAgentId ||
      manifest.owner.conversationId !== options.requesterConversationId
    ) {
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    }
    const expiresAtMs = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("artifact expiry is invalid");
    }
    if (expiresAtMs <= Date.now()) {
      return {
        ok: false,
        reason: "expired",
        message: "shell-output artifact has expired",
      };
    }

    const raw = await readRegularUtf8(
      path.join(realArtifactDirectory, `${options.stream}.txt`),
    );
    const text = toWellFormedUnicode(raw);
    const requestedOffset =
      options.offset !== undefined && Number.isFinite(options.offset)
        ? options.offset
        : 0;
    const requestedLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : ARTIFACT_PAGE_DEFAULT_CHARS;
    const limit = Math.max(
      2,
      Math.min(ARTIFACT_PAGE_MAX_CHARS, Math.floor(requestedLimit)),
    );
    const startOffset = normalizePageStart(text, requestedOffset);
    const endOffset = normalizePageEnd(text, startOffset, limit);
    return {
      ok: true,
      value: {
        handle: options.handle,
        stream: options.stream,
        text: text.slice(startOffset, endOffset),
        startOffset,
        endOffset,
        nextOffset: endOffset,
        totalCharacters: text.length,
        complete: endOffset >= text.length,
        createdAt: manifest.createdAt,
        expiresAt: manifest.expiresAt,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    }
    logger.warn(
      { handle: options.handle, error },
      "[CodingTools] Failed to read shell-output artifact",
    );
    return {
      ok: false,
      reason: "corrupt",
      message: "shell-output artifact could not be read safely",
    };
  }
}
