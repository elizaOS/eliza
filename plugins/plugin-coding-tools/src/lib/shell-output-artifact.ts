/**
 * Persists complete redacted foreground-shell streams when the planner-facing
 * transcript is truncated. Artifacts live in the shared elizaOS state root,
 * inherit the shell job retention window, and are swept opportunistically.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, resolveStateDir } from "@elizaos/core";
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
