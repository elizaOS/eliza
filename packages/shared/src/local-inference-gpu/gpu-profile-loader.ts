/**
 * Per-GPU YAML profile loader.
 *
 * Single-GPU only — the system is framed around "one card per host"
 * (see `packages/shared/src/local-inference/gpu-profiles.ts` for the
 * full constraint). At runtime the agent:
 *
 *   1. Detects the host GPU via `nvidia-smi` (or a test-mode mock).
 *   2. Maps the detected card name → `GpuYamlId`.
 *   3. Reads the matching `profiles/<gpu_id>.yaml`.
 *   4. Zod-validates + cross-checks bundle ids against the catalog.
 *   5. Caches the parsed profile by id.
 *
 * **No real model loads happen in this module.** We only parse YAML and
 * run a string-matching subprocess against `nvidia-smi`. The Mac host
 * that authored the YAMLs (no NVIDIA driver) will return `null` from
 * `detectGpuFromNvidiaSmi` and the runtime falls back to the supplied
 * `GPU_PROFILES` constants in `local-inference/gpu-profiles.ts`.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  bundleIdsInProfileMatchCatalog,
  type GpuYamlId,
  GpuYamlProfile,
} from "./gpu-profile-schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(HERE, "profiles");

/**
 * Test-only override hook. When set, `detectGpuFromNvidiaSmi` returns
 * the canned name without spawning the real subprocess. Tests pass a
 * fixture string; production code never sets this.
 *
 * Exposed via setter (not env var) so test runners that share a Node
 * process can swap the value per-test without polluting `process.env`.
 */
let nvidiaSmiMock:
  | { kind: "name"; value: string }
  | { kind: "missing" }
  | { kind: "real" } = { kind: "real" };

/** Test-only hook — set the next `detectGpuFromNvidiaSmi` result. */
export function __setNvidiaSmiMockForTests(
  mock: typeof nvidiaSmiMock | null,
): void {
  nvidiaSmiMock = mock ?? { kind: "real" };
}

/**
 * Run `nvidia-smi --query-gpu=name --format=csv,noheader` and return the
 * first non-empty line, or `null` if nvidia-smi is missing / the host has
 * no NVIDIA GPU / the command fails for any other reason.
 *
 * Deliberately tolerant: this is a *recommendation* path, not a
 * licence check. Any failure means "no profile applied; use catalog
 * defaults" — never throw.
 */
export function detectGpuFromNvidiaSmi(): string | null {
  if (nvidiaSmiMock.kind === "name") return firstLineOrNull(nvidiaSmiMock.value);
  if (nvidiaSmiMock.kind === "missing") return null;

  const opts: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "pipe"],
  };
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      opts,
    );
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  return firstLineOrNull(String(result.stdout ?? ""));
}

/**
 * Return the first non-empty line of a multi-line string, trimmed.
 * Used to normalize both real `nvidia-smi` output and test mocks so
 * the single-GPU framing is consistent at both paths.
 */
function firstLineOrNull(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : null;
}

/**
 * Map an `nvidia-smi` name line to a profile id. Strict to avoid
 * misclassifying a 3080 as a 3090, or an A100 as a 4090.
 *
 * Pattern matching is case-insensitive and tolerates the two common
 * spellings (`RTX 4090` vs `RTX4090`). Real `nvidia-smi` returns the
 * full marketing name (`NVIDIA GeForce RTX 4090`).
 */
export function classifyGpuName(name: string): GpuYamlId | null {
  const n = name.toLowerCase();
  if (n.includes("h200")) return "h200";
  if (n.includes("rtx 5090") || n.includes("rtx5090")) return "rtx-5090";
  if (n.includes("rtx 4090") || n.includes("rtx4090")) return "rtx-4090";
  if (n.includes("rtx 3090") || n.includes("rtx3090")) return "rtx-3090";
  return null;
}

/** Path to the YAML for a given profile id. */
export function profileYamlPath(id: GpuYamlId): string {
  return join(PROFILE_DIR, `${id}.yaml`);
}

const profileCache = new Map<GpuYamlId, GpuYamlProfile>();

/** Clear the in-memory cache. Test-only. */
export function __clearProfileCacheForTests(): void {
  profileCache.clear();
}

/**
 * Load + validate the YAML for a given profile id. Throws a structured
 * error on schema mismatch or unknown bundle ids — callers should
 * `try/catch` at the runtime boundary and fall back to the catalog
 * defaults.
 *
 * Cached; multiple calls for the same id parse the YAML once per
 * process lifetime.
 */
export function loadProfile(id: GpuYamlId): GpuYamlProfile {
  const cached = profileCache.get(id);
  if (cached) return cached;

  const path = profileYamlPath(id);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `gpu-profile-loader: failed to read ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(
      `gpu-profile-loader: failed to parse YAML at ${path}: ${(err as Error).message}`,
    );
  }
  const result = GpuYamlProfile.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `gpu-profile-loader: schema validation failed for ${path}: ${issues}`,
    );
  }
  const profile = result.data;
  if (profile.gpu_id !== id) {
    throw new Error(
      `gpu-profile-loader: ${path} declares gpu_id="${profile.gpu_id}" but was loaded as "${id}"`,
    );
  }
  const catalogCheck = bundleIdsInProfileMatchCatalog(profile);
  if (!catalogCheck.ok) {
    throw new Error(
      `gpu-profile-loader: ${path} references unknown Eliza-1 tier ids: ${catalogCheck.unknown.join(", ")}`,
    );
  }
  profileCache.set(id, profile);
  return profile;
}

/** Result of `resolveProfileForHost` — discriminated union for callers. */
export type ResolveResult =
  | {
      ok: true;
      profile: GpuYamlProfile;
      detectedName: string;
      gpuId: GpuYamlId;
    }
  | {
      ok: false;
      reason: "no-nvidia-gpu" | "unsupported-gpu" | "profile-load-failed";
      detectedName: string | null;
      error?: string;
    };

/**
 * One-shot detection + load. Returns a discriminated result so the
 * runtime can decide between "apply YAML overrides" and "fall back to
 * the catalog defaults".
 *
 * Conservative fallback policy: if any step fails, callers should use
 * `rtx-3090` (the most conservative supported card) — but that decision
 * is *not* made here; it's the caller's call so the runtime can log
 * which fallback rule fired.
 */
export function resolveProfileForHost(): ResolveResult {
  const name = detectGpuFromNvidiaSmi();
  if (!name) {
    return { ok: false, reason: "no-nvidia-gpu", detectedName: null };
  }
  const gpuId = classifyGpuName(name);
  if (!gpuId) {
    return { ok: false, reason: "unsupported-gpu", detectedName: name };
  }
  try {
    const profile = loadProfile(gpuId);
    return { ok: true, profile, detectedName: name, gpuId };
  } catch (err) {
    return {
      ok: false,
      reason: "profile-load-failed",
      detectedName: name,
      error: (err as Error).message,
    };
  }
}

/**
 * Conservative fallback profile id. Used by the runtime when detection
 * fails and the operator has opted into "always apply some profile".
 * Returns the lowest-spec supported card so flags are safe everywhere.
 */
export const FALLBACK_PROFILE_ID: GpuYamlId = "rtx-3090";
