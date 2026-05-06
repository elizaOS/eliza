/**
 * Backend selection + re-exports.
 *
 * `selectBackend()` reads `NATIVE_REASONING_BACKEND` and returns an
 * implementation. Default: anthropic. The public package ships both the
 * Anthropic API backend and the Codex backend that uses ChatGPT subscription
 * auth from the codex CLI token cache.
 */

import { logger } from "@elizaos/core";

import { AnthropicBackend, type AnthropicBackendOptions } from "./anthropic.js";
import { CodexBackend, type CodexBackendConfig } from "./codex.js";
import type { ReasoningBackend } from "./types.js";

export type BackendName = "anthropic" | "codex";

export interface SelectBackendOptions {
  /** Force a specific backend (overrides env). */
  backend?: BackendName;
  /** Forwarded to AnthropicBackend if it's selected. */
  anthropic?: AnthropicBackendOptions;
  /** Forwarded to CodexBackend if it's selected. */
  codex?: CodexBackendConfig;
}

/** Read `NATIVE_REASONING_BACKEND` from env, normalized. */
function readBackendEnv(): BackendName | undefined {
  const raw = process.env.NATIVE_REASONING_BACKEND?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "anthropic" || raw === "codex") return raw;
  logger.warn(
    `[native-reasoning] unknown NATIVE_REASONING_BACKEND="${raw}", falling back to anthropic`,
  );
  return undefined;
}

/** Select and instantiate a backend. */
export function selectBackend(
  opts: SelectBackendOptions = {},
): ReasoningBackend {
  const choice: BackendName = opts.backend ?? readBackendEnv() ?? "anthropic";

  switch (choice) {
    case "anthropic": {
      logger.debug("[native-reasoning] backend=anthropic");
      return new AnthropicBackend(opts.anthropic);
    }
    case "codex": {
      logger.debug("[native-reasoning] backend=codex");
      return new CodexBackend(opts.codex);
    }
    default: {
      const _x: never = choice;
      throw new Error(`unreachable backend: ${_x as string}`);
    }
  }
}

export type {
  AnthropicBackendOptions,
  AnthropicClientLike,
} from "./anthropic.js";
export { AnthropicBackend } from "./anthropic.js";
export type { CodexBackendConfig } from "./codex.js";
export { CodexBackend } from "./codex.js";
export type {
  CallTurnOptions,
  ReasoningBackend,
  TextBlock,
  ToolCallRequest,
  ToolResultBlock,
  ToolUseBlock,
  TurnContentBlock,
  TurnMessage,
  TurnResult,
} from "./types.js";
