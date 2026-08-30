/**
 * Spawn-spec builders for interactive eliza-code PTY sessions.
 * The pure builders point the owned eliza-code CLI at Eliza Cloud with coding-only confinement so cockpit sessions run a real slash-command terminal without inheriting the server environment.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/core";
import {
  type DevCloudEnvAuthority,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import type { PtySpawnSpec } from "../services/pty-types";

export const ELIZA_CLOUD_DEFAULT_BASE_URL = "https://api.eliza.app/v1";
export const ELIZA_CLOUD_FAST_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;
export const ELIZA_CLOUD_SMART_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;

export interface ElizaCodeCloudTuple {
  /** Immutable launcher authority, or null for the legacy operator-controlled path. */
  authority: DevCloudEnvAuthority | null;
  /** False when the selected development target intentionally disables Cloud. */
  enabled: boolean;
  /** Credential the child must use when Cloud is enabled. */
  apiKey?: string;
  /** OpenAI-compatible inference base URL the child must use. */
  baseUrl?: string;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Convert the canonical Cloud control-plane base (`/api/v1`) stamped by the
 * launcher into the OpenAI-compatible inference base (`/v1`) consumed by
 * eliza-code. Self-hosted roots that already expose another path are preserved.
 */
function toElizaCodeInferenceBaseUrl(
  value: string | undefined,
): string | undefined {
  const normalized = trimmed(value)?.replace(/\/+$/, "");
  return normalized?.replace(/\/api\/v1$/, "/v1");
}

/**
 * Resolve the only Cloud tuple an eliza-code child may use. A valid launcher
 * authority owns the tuple completely: blocked targets disable the Cloud lane,
 * while explicit targets ignore caller/runtime/process overrides and read the
 * process-lifetime snapshot. Without authority, preserve the historical
 * per-session/operator inputs.
 */
export function resolveElizaCodeCloudTuple(input?: {
  apiKey?: string;
  baseUrl?: string;
}): ElizaCodeCloudTuple {
  const authority = resolveDevCloudEnvAuthority();
  if (authority === "staging-default" || authority === "offline") {
    return { authority, enabled: false };
  }
  if (authority) {
    return {
      authority,
      enabled: true,
      apiKey: trimmed(
        resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_API_KEY"),
      ),
      baseUrl: toElizaCodeInferenceBaseUrl(
        resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_BASE_URL"),
      ),
    };
  }
  return {
    authority: null,
    enabled: true,
    apiKey: trimmed(input?.apiKey),
    baseUrl: trimmed(input?.baseUrl) ?? ELIZA_CLOUD_DEFAULT_BASE_URL,
  };
}

function isAuthorityControlledChildEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    normalized === "OPENAI_API_KEY" ||
    normalized === "OPENAI_BASE_URL" ||
    normalized === "PTY_ELIZA_CLOUD_API_KEY" ||
    normalized === "PTY_ELIZA_CLOUD_BASE_URL" ||
    normalized.startsWith("ELIZAOS_CLOUD_") ||
    normalized.startsWith("ELIZA_CLOUD_") ||
    normalized.startsWith("ELIZACLOUD_") ||
    normalized.startsWith("WAIFU_ELIZA_CLOUD_")
  );
}

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

/**
 * Builds the spawn spec. Performs no I/O or process spawn; when a development
 * Cloud authority exists it reads only that immutable launcher snapshot.
 */
export function buildElizaCodeCerebrasSpec(
  opts: ElizaCodeCerebrasOptions,
): PtySpawnSpec {
  const cloud = resolveElizaCodeCloudTuple({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });
  if (!cloud.enabled) {
    throw new Error(
      `eliza-code Cloud sessions are disabled for the ${cloud.authority} development target.`,
    );
  }
  const apiKey = cloud.apiKey;
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

  const baseUrl = cloud.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "eliza-code interactive session requires an Eliza Cloud base URL.",
    );
  }
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

  // A direct library caller can otherwise smuggle a second Cloud tuple through
  // extraEnv after the validated values. Clamp the final child projection too,
  // so route validation is not the only authority boundary.
  if (cloud.authority) {
    for (const key of Object.keys(env)) {
      if (isAuthorityControlledChildEnvKey(key)) delete env[key];
    }
    env.OPENAI_API_KEY = apiKey;
    env.OPENAI_BASE_URL = baseUrl;
  }

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
 * Resolves the operator-supplied interactive eliza-code entry. The CLI is an
 * external runtime dependency, so deployments must provide an absolute
 * `ELIZA_CODE_BIN` path rather than relying on a repository-owned bundle.
 */
export function resolveElizaCodeBin(opts?: {
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
}): string {
  const env = opts?.env ?? process.env;
  const exists = opts?.exists ?? existsSync;

  const configuredPath = env.ELIZA_CODE_BIN?.trim();
  if (!configuredPath) {
    throw new Error(
      "ELIZA_CODE_BIN must be set to the absolute path of an installed eliza-code entrypoint.",
    );
  }
  if (!path.isAbsolute(configuredPath)) {
    throw new Error("ELIZA_CODE_BIN must be an absolute path.");
  }
  if (!exists(configuredPath)) {
    throw new Error(
      `ELIZA_CODE_BIN is set to "${configuredPath}" but no file exists there.`,
    );
  }
  return path.resolve(configuredPath);
}
