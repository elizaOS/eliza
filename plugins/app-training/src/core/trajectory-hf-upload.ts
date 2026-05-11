/**
 * Runtime → HuggingFace trajectory upload.
 *
 * Uploads the *sanitized* JSONL produced by `buildTrajectoryExportBundle` (or
 * the nightly export cron) to a HuggingFace dataset repo. The upload is
 * opt-in: it only runs when `MILADY_TRAJECTORY_HF_REPO` is set AND an HF token
 * is available (`HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`).
 *
 * The privacy filter MUST have run before this — callers pass the already
 * sanitized file path. This module never reads raw trajectory data.
 *
 * Transport: shells out to the HuggingFace CLI (`hf upload`, falling back to
 * the legacy `huggingface-cli upload`). If neither is on PATH the upload is
 * skipped with an actionable "install the HF CLI" message rather than failing
 * the export.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const HF_REPO_ENV = "MILADY_TRAJECTORY_HF_REPO";
const HF_TOKEN_ENVS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;

export interface HfUploadConfig {
  /** `org/dataset` repo id. */
  repo: string;
  /** HF access token. */
  token: string;
}

export interface HfUploadResult {
  /** True only when the file was actually uploaded. */
  uploaded: boolean;
  /** Repo the file was uploaded to (or would have been). */
  repo: string | null;
  /** Path-in-repo the file landed at. */
  pathInRepo: string | null;
  /** Populated when `uploaded` is false and the reason is not "not configured". */
  error: string | null;
  /** True when the upload was skipped because the env is not configured. */
  skippedNotConfigured: boolean;
}

/**
 * Resolve the upload config from the environment. Returns `null` when the
 * feature is not configured (no repo env, or no token).
 */
export function resolveHfUploadConfig(
  env: NodeJS.ProcessEnv = process.env,
): HfUploadConfig | null {
  const repo = env[HF_REPO_ENV]?.trim();
  if (!repo) return null;
  for (const key of HF_TOKEN_ENVS) {
    const token = env[key]?.trim();
    if (token) return { repo, token };
  }
  return null;
}

function notConfigured(): HfUploadResult {
  return {
    uploaded: false,
    repo: null,
    pathInRepo: null,
    error: null,
    skippedNotConfigured: true,
  };
}

async function runHfCli(
  args: string[],
  token: string,
): Promise<{ ok: boolean; stderr: string; missing: boolean }> {
  const candidates = ["hf", "huggingface-cli"];
  let lastErr = "";
  for (const bin of candidates) {
    const attempt = await new Promise<{
      ok: boolean;
      stderr: string;
      missing: boolean;
    }>((resolve) => {
      const child = spawn(bin, args, {
        env: { ...process.env, HF_TOKEN: token, HUGGING_FACE_HUB_TOKEN: token },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        resolve({
          ok: false,
          stderr: err.message,
          missing: err.code === "ENOENT",
        });
      });
      child.on("close", (code) => {
        resolve({ ok: code === 0, stderr, missing: false });
      });
    });
    if (!attempt.missing) return attempt;
    lastErr = attempt.stderr;
  }
  return {
    ok: false,
    stderr: lastErr || "HuggingFace CLI not found on PATH",
    missing: true,
  };
}

/**
 * Upload a sanitized JSONL file to the configured HF dataset repo.
 *
 * @param sanitizedJsonlPath - Path to the already-privacy-filtered JSONL.
 * @param pathInRepo - Destination path inside the dataset repo.
 * @param config - Resolved upload config; pass `null` (or omit) to read the env.
 */
export async function uploadTrajectoryJsonlToHuggingFace(
  sanitizedJsonlPath: string,
  pathInRepo: string,
  config: HfUploadConfig | null = resolveHfUploadConfig(),
): Promise<HfUploadResult> {
  if (!config) return notConfigured();
  if (!existsSync(sanitizedJsonlPath)) {
    return {
      uploaded: false,
      repo: config.repo,
      pathInRepo,
      error: `sanitized JSONL not found at ${sanitizedJsonlPath}`,
      skippedNotConfigured: false,
    };
  }

  const result = await runHfCli(
    [
      "upload",
      config.repo,
      sanitizedJsonlPath,
      pathInRepo,
      "--repo-type",
      "dataset",
    ],
    config.token,
  );
  if (result.ok) {
    return {
      uploaded: true,
      repo: config.repo,
      pathInRepo,
      error: null,
      skippedNotConfigured: false,
    };
  }
  const error = result.missing
    ? "HuggingFace CLI not found. Install it with `pip install -U \"huggingface_hub[cli]\"` (provides `hf` / `huggingface-cli`) to enable trajectory uploads."
    : `hf upload failed: ${result.stderr.trim().slice(0, 500)}`;
  return {
    uploaded: false,
    repo: config.repo,
    pathInRepo,
    error,
    skippedNotConfigured: false,
  };
}
