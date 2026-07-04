/**
 * Spawn-spec builders for interactive eliza-code PTY sessions.
 * The pure builders point the owned eliza-code CLI at Eliza Cloud with coding-only confinement so cockpit sessions run a real slash-command terminal without inheriting the server environment.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/core";
import type { PtySpawnSpec } from "../services/pty-types";

export const ELIZA_CLOUD_DEFAULT_BASE_URL = "https://api.elizacloud.ai/v1";
export const ELIZA_CLOUD_FAST_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;
export const ELIZA_CLOUD_SMART_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;

export interface ElizaCodeCerebrasOptions {
  /** Working directory the interactive session runs in (confined to this). */
  cwd: string;
  /** Eliza Cloud API key (OpenAI-compatible). Required. */
  apiKey: string;
  /** Absolute path to the built interactive eliza-code entry (dist/index.js). */
  binPath: string;
  /** Executable used to run the bundle. eliza-code builds `--target bun`. */
  runner?: string;
  /** OpenAI-compatible base URL. Defaults to Eliza Cloud. */
  baseUrl?: string;
  /** Fast-tier model id (cerebras). */
  fastModel?: string;
  /** Smart-tier model id. */
  smartModel?: string;
  /**
   * Which tier the session leads with. "fast" (default) keeps small=fast with
   * smart as the heavy-call fallback; "smart" makes even quick calls use the
   * smart model (small=smart).
   */
  tier?: "fast" | "smart";
  /** Extra env overrides merged last (tests / advanced callers). */
  extraEnv?: Record<string, string | undefined>;
}

/** Builds the spawn spec. Pure — no I/O, no process spawn; validates inputs. */
export function buildElizaCodeCerebrasSpec(
  opts: ElizaCodeCerebrasOptions,
): PtySpawnSpec {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "eliza-code interactive session requires an Eliza Cloud API key (apiKey).",
    );
  }
  if (!opts.cwd?.trim()) {
    throw new Error("eliza-code interactive session requires a cwd.");
  }
  if (!opts.binPath?.trim()) {
    throw new Error(
      "eliza-code interactive session requires a resolved binPath (dist/index.js).",
    );
  }

  const baseUrl = (opts.baseUrl ?? ELIZA_CLOUD_DEFAULT_BASE_URL).trim();
  const fastModel = (opts.fastModel ?? ELIZA_CLOUD_FAST_MODEL).trim();
  const smartModel = (opts.smartModel ?? ELIZA_CLOUD_SMART_MODEL).trim();
  const tier = opts.tier ?? "fast";
  const runner = (opts.runner ?? "bun").trim();
  const cwd = path.resolve(opts.cwd);

  // Small/medium follow the tier; large is always the smart model so heavy
  // reasoning calls escalate even in fast mode.
  const smallModel = tier === "smart" ? smartModel : fastModel;

  const env: Record<string, string | undefined> = {
    ELIZA_CODE_PROVIDER: "openai",
    ELIZA_CODE_CODING_ONLY: "1",
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: baseUrl,
    OPENAI_SMALL_MODEL: smallModel,
    OPENAI_MEDIUM_MODEL: smallModel,
    OPENAI_LARGE_MODEL: smartModel,
    // Confine eliza-code's own file/shell tools to the session cwd.
    CODING_TOOLS_WORKSPACE_ROOTS: cwd,
    SHELL_ALLOWED_DIRECTORY: cwd,
    ...(opts.extraEnv ?? {}),
  };

  return {
    command: runner,
    args: [opts.binPath, "--interactive", "--coding-only"],
    cwd,
    env,
    label: `eliza-code · ${tier} · ${tier === "smart" ? smartModel : fastModel}`,
    kind: "eliza-code",
  };
}

/**
 * Resolves the built interactive eliza-code entry (`dist/index.js`). Order:
 *   1. explicit `ELIZA_CODE_BIN` env (absolute path),
 *   2. walk up from `startDir` looking for `packages/examples/code/dist/index.js`.
 * Throws with actionable guidance when it can't be found (the bundle must be
 * built: `bun run --cwd packages/examples/code build`).
 */
export function resolveElizaCodeBin(opts?: {
  env?: Record<string, string | undefined>;
  startDir?: string;
  exists?: (p: string) => boolean;
}): string {
  const env = opts?.env ?? process.env;
  const exists = opts?.exists ?? existsSync;

  const override = env.ELIZA_CODE_BIN?.trim();
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `ELIZA_CODE_BIN is set to "${override}" but no file exists there.`,
      );
    }
    return path.resolve(override);
  }

  const rel = path.join("packages", "examples", "code", "dist", "index.js");
  let dir = path.resolve(opts?.startDir ?? process.cwd());
  // Walk up to the filesystem root looking for the workspace entry.
  for (;;) {
    const candidate = path.join(dir, rel);
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "Could not locate the interactive eliza-code binary " +
      `(${rel}). Build it with "bun run --cwd packages/examples/code build", ` +
      "or set ELIZA_CODE_BIN to its absolute path.",
  );
}
