import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { ClaudeCli } from "./src/claude-cli";
import { CodexCli } from "./src/codex-cli-exec";

/**
 * @elizaos/plugin-cli-inference — the TOS-clean SAFE/CLOUD inference route.
 *
 * Serves chat/planner inference by SPAWNING the sanctioned local CLI:
 *   - `claude --print`  (reads ~/.claude/.credentials.json itself), or
 *   - `codex exec`      (reads ~/.codex/auth.json itself).
 *
 * eliza never sees/forwards/logs the subscription token — the child env is
 * filtered (allowlist + secret blocklist) and the CLI loads its own creds. This
 * is the develop-shippable peer to the two never-commit, TOS-gray bypass paths
 * (the claude-code-stealth fetch interceptor in
 * `packages/agent/src/auth/credentials.ts` and plugin-codex-cli `postResponses`)
 * which replay the consumer-subscription token in-process.
 *
 * The whole models map is INERT unless `ELIZA_CHAT_VIA_CLI` is `claude` or
 * `codex`. We register TEXT_LARGE / TEXT_MEGA / RESPONSE_HANDLER only:
 *
 *   - RESPONSE_HANDLER is the whole point — it generates the user-facing reply,
 *     which is exactly what "chat on the sub" means. That is one CLI spawn per
 *     turn that actually answers (~3-4s).
 *   - TEXT_LARGE / TEXT_MEGA cover other large free-text generations (e.g. the
 *     post-turn evaluator) — also occasional, also tolerant of plain text.
 *   - ACTION_PLANNER is deliberately NOT registered: the planner relies on
 *     GBNF / native-tool / responseSchema enforcement that `claude --print` and
 *     `codex exec` cannot honor (they emit free text), so the planner stays on
 *     the configured grammar/tool-honoring provider (cerebras / zai).
 *
 * High-frequency should-respond/triage (TEXT_SMALL/NANO/MEDIUM) is never
 * registered, so per-turn CLI spawn cost is just the user-facing reply via
 * RESPONSE_HANDLER, plus possibly the post-turn evaluator — not the planner and
 * not the cheap triage calls.
 */

const TEXT_MEGA_MODEL_TYPE: string = ModelType.TEXT_MEGA;
const RESPONSE_HANDLER_MODEL_TYPE: string = ModelType.RESPONSE_HANDLER;

/** Large-tier model types this plugin registers (when enabled). */
const LARGE_TIER_MODEL_TYPES: readonly string[] = [
  ModelType.TEXT_LARGE,
  TEXT_MEGA_MODEL_TYPE,
  RESPONSE_HANDLER_MODEL_TYPE,
];

type CliBackend = "claude" | "codex";

type RuntimeWithSettings = IAgentRuntime & {
  getSetting?: (key: string) => string | number | boolean | undefined | null;
};

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = (runtime as RuntimeWithSettings).getSetting?.(key);
  return value === undefined || value === null ? readEnv(key) : String(value);
}

/** Resolve the configured backend, or undefined when the plugin is inert. */
export function resolveCliBackend(source: { ELIZA_CHAT_VIA_CLI?: string }): CliBackend | undefined {
  const raw = source.ELIZA_CHAT_VIA_CLI?.trim().toLowerCase();
  if (raw === "claude" || raw === "codex") return raw;
  return undefined;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildClaude(runtime: IAgentRuntime): ClaudeCli {
  return new ClaudeCli({
    model: getSetting(runtime, "ELIZA_CLI_CLAUDE_MODEL"),
    timeoutMs: parseTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
  });
}

function buildCodex(runtime: IAgentRuntime): CodexCli {
  return new CodexCli({
    model: getSetting(runtime, "ELIZA_CLI_CODEX_MODEL"),
    timeoutMs: parseTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
  });
}

async function generateViaCli(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: string
): Promise<string> {
  const backend = resolveCliBackend({
    ELIZA_CHAT_VIA_CLI: getSetting(runtime, "ELIZA_CHAT_VIA_CLI"),
  });
  if (!backend) {
    // Should be unreachable: the handlers are only registered when a backend is
    // set. Throw so useModel/AccountPool treat it as a provider failure rather
    // than silently returning empty.
    throw new Error("[cli-inference] ELIZA_CHAT_VIA_CLI is not set to claude|codex");
  }
  const generateParams = {
    system: params.system,
    prompt: params.prompt,
    messages: params.messages,
  };
  logger.debug(`[cli-inference] ${modelType} via ${backend} CLI`);
  const cli = backend === "claude" ? buildClaude(runtime) : buildCodex(runtime);
  return cli.generate(generateParams);
}

/**
 * Build the models map. When no backend is configured the map is EMPTY so the
 * plugin registers nothing and the cheap configured provider keeps serving
 * every tier.
 */
export function buildModels(
  source: { ELIZA_CHAT_VIA_CLI?: string } = { ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") }
): Plugin["models"] {
  if (!resolveCliBackend(source)) return {};
  const models: Record<
    string,
    (runtime: IAgentRuntime, params: GenerateTextParams) => Promise<string>
  > = {};
  for (const modelType of LARGE_TIER_MODEL_TYPES) {
    models[modelType] = (runtime, params) => generateViaCli(runtime, params, modelType);
  }
  return models as Plugin["models"];
}

export const cliInferencePlugin: Plugin = {
  name: "cli-inference",
  description:
    "TOS-clean SAFE/CLOUD inference: spawns the sanctioned claude/codex CLI as large-tier model handlers; the CLI reads its own creds. Inert unless ELIZA_CHAT_VIA_CLI=claude|codex.",
  // High priority so that, when ELIZA_CHAT_VIA_CLI is set, this plugin
  // deterministically wins the tiers it registers (TEXT_LARGE / TEXT_MEGA /
  // RESPONSE_HANDLER) over default-priority (0) model providers like
  // plugin-anthropic that would otherwise tie and resolve non-deterministically.
  priority: 100,
  config: {
    ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") ?? null,
    ELIZA_CLI_CLAUDE_MODEL: readEnv("ELIZA_CLI_CLAUDE_MODEL") ?? null,
    ELIZA_CLI_CODEX_MODEL: readEnv("ELIZA_CLI_CODEX_MODEL") ?? null,
    ELIZA_CLI_TIMEOUT_MS: readEnv("ELIZA_CLI_TIMEOUT_MS") ?? null,
  },
  async init(): Promise<void> {
    const backend = resolveCliBackend({ ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") });
    if (!backend) {
      logger.info("[cli-inference] ELIZA_CHAT_VIA_CLI unset — plugin inert (no models registered)");
      return;
    }
    // Double-activation guard: the in-process claude-code-stealth interceptor and
    // this CLI-spawn path are two colliding claude routes. This guard lives HERE
    // (not in credentials.ts, which is skip-worktree on the live branch).
    const stealth = readEnv("ELIZA_ENABLE_CLAUDE_STEALTH")?.trim().toLowerCase();
    const stealthOn =
      stealth === "1" || stealth === "true" || stealth === "yes" || stealth === "on";
    if (backend === "claude" && stealthOn) {
      throw new Error(
        "[cli-inference] ELIZA_CHAT_VIA_CLI=claude collides with ELIZA_ENABLE_CLAUDE_STEALTH. " +
          "Pick one claude inference route (CLI spawn vs in-process stealth interceptor)."
      );
    }
    logger.info(
      `[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=${backend} — large-tier handlers spawn the ${backend} CLI`
    );
  },
  models: buildModels(),
};

export { ClaudeCli } from "./src/claude-cli";
export { CodexCli, parseCodexJsonl } from "./src/codex-cli-exec";
export { flattenPrompt } from "./src/prompt-flatten";
export { LARGE_TIER_MODEL_TYPES };

export default cliInferencePlugin;
