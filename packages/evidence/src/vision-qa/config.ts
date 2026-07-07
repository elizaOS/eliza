/**
 * Backend resolution from environment. Selection order: an explicit
 * `AskOptions.backend` wins; else `ELIZA_VISION_QA_BACKEND` if set; else
 * default to `anthropic` when `ANTHROPIC_API_KEY` is present, else `local` when
 * a base URL is configured, else a typed NOT_CONFIGURED failure. There is no
 * fabricated-answer fallback: a run with no reachable backend fails loudly so
 * the keyless-environment contract ("explicit skipped record, never invented
 * answers") holds at the boundary above this.
 */

import { EvidenceError } from "../errors.ts";
import {
  ANTHROPIC_BASE_URL,
  AnthropicBackend,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_OPENAI_MODEL,
  OPENAI_BASE_URL,
  OpenAiCompatibleBackend,
  type VisionBackendClient,
} from "./backends.ts";
import { CliVisionBackend, type VisionCli } from "./cli-backend.ts";
import type { AskOptions, VisionBackend } from "./types.ts";

/** Env var names read for backend resolution — the whole surface, in one place. */
export const ENV = {
  backend: "ELIZA_VISION_QA_BACKEND",
  baseUrl: "ELIZA_VISION_QA_BASE_URL",
  anthropicKey: "ANTHROPIC_API_KEY",
  openaiKey: "OPENAI_API_KEY",
  cli: "ELIZA_VISION_QA_CLI",
} as const;

const VALID_BACKENDS: readonly VisionBackend[] = [
  "anthropic",
  "openai",
  "local",
  "cli",
];

const VALID_CLIS: readonly VisionCli[] = ["claude", "codex"];
export const DEFAULT_CLI: VisionCli = "claude";

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Decide which backend to use given explicit options and the environment.
 * Throws `VISION_NOT_CONFIGURED` when nothing is reachable — the caller turns
 * that into a `skipped` record, never a fabricated answer.
 */
export function resolveBackend(
  options: Pick<AskOptions, "backend" | "baseUrl">,
  env: NodeJS.ProcessEnv = process.env,
): VisionBackend {
  const explicit = options.backend ?? readEnv(env, ENV.backend);
  if (explicit !== undefined) {
    if (!VALID_BACKENDS.includes(explicit as VisionBackend)) {
      throw new EvidenceError(
        `invalid ${ENV.backend}: '${explicit}' (expected ${VALID_BACKENDS.join("|")})`,
        { code: "VISION_CONFIG", context: { value: explicit } },
      );
    }
    return explicit as VisionBackend;
  }
  if (readEnv(env, ENV.anthropicKey) !== undefined) return "anthropic";
  if (
    options.baseUrl !== undefined ||
    readEnv(env, ENV.baseUrl) !== undefined
  ) {
    return "local";
  }
  throw new EvidenceError(
    `vision-qa is not configured: set ${ENV.anthropicKey}, or ${ENV.baseUrl} for a local server, or pass an explicit backend`,
    { code: "VISION_NOT_CONFIGURED" },
  );
}

/**
 * Build the concrete backend client for a resolved backend, pulling the key and
 * base URL from options or env. A backend selected without its required
 * credential throws `VISION_NOT_CONFIGURED` (not a partial client that would
 * fail mid-request with an opaque 401).
 */
export function createBackendClient(
  backend: VisionBackend,
  options: Pick<AskOptions, "model" | "baseUrl" | "apiKey">,
  env: NodeJS.ProcessEnv = process.env,
): VisionBackendClient | CliVisionBackend {
  switch (backend) {
    case "anthropic": {
      const apiKey = options.apiKey ?? readEnv(env, ENV.anthropicKey);
      if (apiKey === undefined) {
        throw new EvidenceError(
          `anthropic backend requires ${ENV.anthropicKey}`,
          { code: "VISION_NOT_CONFIGURED", context: { backend } },
        );
      }
      return new AnthropicBackend(
        options.model ?? DEFAULT_ANTHROPIC_MODEL,
        apiKey,
        options.baseUrl ?? readEnv(env, ENV.baseUrl) ?? ANTHROPIC_BASE_URL,
      );
    }
    case "openai": {
      const apiKey = options.apiKey ?? readEnv(env, ENV.openaiKey);
      if (apiKey === undefined) {
        throw new EvidenceError(`openai backend requires ${ENV.openaiKey}`, {
          code: "VISION_NOT_CONFIGURED",
          context: { backend },
        });
      }
      return new OpenAiCompatibleBackend(
        options.model ?? DEFAULT_OPENAI_MODEL,
        apiKey,
        options.baseUrl ?? readEnv(env, ENV.baseUrl) ?? OPENAI_BASE_URL,
      );
    }
    case "local": {
      const baseUrl = options.baseUrl ?? readEnv(env, ENV.baseUrl);
      if (baseUrl === undefined) {
        throw new EvidenceError(
          `local backend requires ${ENV.baseUrl} (the llama-server OpenAI-compatible endpoint)`,
          { code: "VISION_NOT_CONFIGURED", context: { backend } },
        );
      }
      // Local llama-server needs no key; an empty key means "omit auth header".
      return new OpenAiCompatibleBackend(
        options.model ??
          readEnv(env, "ELIZA_VISION_QA_MODEL") ??
          DEFAULT_LOCAL_MODEL,
        options.apiKey ?? readEnv(env, ENV.openaiKey) ?? "",
        baseUrl,
      );
    }
    case "cli": {
      const cli = resolveCli(env);
      // The model is recorded for provenance; the CLI's own config picks the
      // concrete model, so the id names the CLI transport honestly.
      return new CliVisionBackend({
        cli,
        model: options.model ?? `${cli}-cli`,
      });
    }
  }
}

/** Which coding-agent CLI backs the `cli` backend: `ELIZA_VISION_QA_CLI` or claude. */
export function resolveCli(env: NodeJS.ProcessEnv = process.env): VisionCli {
  const raw = readEnv(env, ENV.cli);
  if (raw === undefined) return DEFAULT_CLI;
  if (!VALID_CLIS.includes(raw as VisionCli)) {
    throw new EvidenceError(
      `invalid ${ENV.cli}: '${raw}' (expected ${VALID_CLIS.join("|")})`,
      { code: "VISION_CONFIG", context: { value: raw } },
    );
  }
  return raw as VisionCli;
}
