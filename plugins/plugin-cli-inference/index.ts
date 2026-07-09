import { createHash } from "node:crypto";
import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import {
  type RotationSubprocessEnv,
  rotationEnabled,
  withAccountRotation,
} from "./src/account-rotation";
import { ClaudeCli } from "./src/claude-cli";
import { ClaudeSdkSession } from "./src/claude-sdk-session";
import {
  appendTextDirective,
  buildCleanRoutingParams,
  buildRouterBody,
  frameTextSystemPrompt,
  ROUTER_SYSTEM_PROMPT,
} from "./src/clean-routing-planner";
import { CodexCli } from "./src/codex-cli-exec";
import { CodexSdkSession } from "./src/codex-sdk-session";
import { flattenPrompt } from "./src/prompt-flatten";

/**
 * @elizaos/plugin-cli-inference — the TOS-clean SAFE/CLOUD inference route.
 *
 * Serves chat/planner inference through sanctioned local routes:
 *   - `claude --print`  (reads ~/.claude/.credentials.json itself), or
 *   - a warm Claude Agent SDK session (reads the Claude subscription creds itself), or
 *   - `codex exec`      (reads ~/.codex/auth.json itself).
 *
 * eliza never sees/forwards/logs the subscription token — the child env is
 * filtered (allowlist + secret blocklist) and the CLI loads its own creds. This
 * is the develop-shippable peer to the two never-commit, TOS-gray bypass paths
 * (the claude-code-stealth fetch interceptor in
 * `packages/agent/src/auth/credentials.ts` and plugin-codex-cli `postResponses`)
 * which replay the consumer-subscription token in-process.
 *
 * The whole models map is INERT unless `ELIZA_CHAT_VIA_CLI` is `claude`,
 * `claude-sdk`, or `codex`. We register TEXT_LARGE / TEXT_MEGA /
 * RESPONSE_HANDLER only:
 *
 *   - RESPONSE_HANDLER is the whole point — it generates the user-facing reply,
 *     which is exactly what "chat on the sub" means. That is one CLI spawn per
 *     turn that actually answers (~3-4s).
 *   - TEXT_LARGE / TEXT_MEGA cover other large free-text generations (e.g. the
 *     post-turn evaluator) — also occasional, also tolerant of plain text.
 *   - ACTION_PLANNER is registered ONLY in text-planner mode
 *     (`ELIZA_PLANNER_NATIVE_TOOLS=0`), where the planner emits an XML
 *     `<response><actions>` block the free-text CLI CAN produce. With native
 *     tools on (the default), the planner needs GBNF / native-tool /
 *     responseSchema enforcement the CLI cannot honor, so it stays on the
 *     grammar/tool-honoring provider (cerebras / zai / anthropic). Gating on
 *     `NATIVE_TOOLS=0` lets the SAFE route run STANDALONE (chat + planner +
 *     coding all on the subscription CLI) without ever hijacking a hybrid setup.
 *
 * High-frequency should-respond/triage (TEXT_SMALL/NANO/MEDIUM) is never
 * registered, so per-turn CLI spawn cost stays bounded to the user-facing reply
 * via RESPONSE_HANDLER, the planner (text mode only), and possibly the post-turn
 * evaluator — not the cheap triage calls.
 */

/** Large-tier free-text model types this plugin registers (when enabled). */
const LARGE_TIER_MODEL_TYPES: readonly string[] = [
  ModelType.TEXT_LARGE,
  ModelType.TEXT_MEGA,
  ModelType.RESPONSE_HANDLER,
];

/**
 * The planner. Registered ONLY in text-planner mode so the SAFE/CLI route can
 * run standalone. The free-text CLI can emit the XML `<actions>` block but cannot
 * honor GBNF/native-tool enforcement, so this REQUIRES `ELIZA_PLANNER_NATIVE_TOOLS=0`.
 */
const PLANNER_MODEL_TYPES: readonly string[] = [ModelType.ACTION_PLANNER];

/** True when the runtime is set for the XML text planner the free-text CLI can serve. */
function textPlannerEnabled(): boolean {
  return readEnv("ELIZA_PLANNER_NATIVE_TOOLS")?.trim() === "0";
}

// "claude"      → cold `claude --print` per call (TOS-clean, but ~5-15s/call).
// "claude-sdk"  → WARM Claude Agent SDK session (TOS-clean + sanctioned + fast
//                 ~2s/turn after warm-up); the recommended Claude route.
// "codex"       → cold `codex exec` per call (TOS-clean ChatGPT OAuth).
// "codex-sdk"   → WARM Codex SDK thread (TOS-clean ChatGPT OAuth + fast); the
//                 codex peer of claude-sdk. ROUTE mode uses native outputSchema.
type CliBackend = "claude" | "claude-sdk" | "codex" | "codex-sdk";

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return value === undefined || value === null ? readEnv(key) : String(value);
}

/** Resolve the configured backend, or undefined when the plugin is inert. */
export function resolveCliBackend(source: { ELIZA_CHAT_VIA_CLI?: string }): CliBackend | undefined {
  const raw = source.ELIZA_CHAT_VIA_CLI?.trim().toLowerCase();
  if (raw === "claude" || raw === "claude-sdk" || raw === "codex" || raw === "codex-sdk") {
    return raw;
  }
  return undefined;
}

// Persistent warm Agent SDK sessions. The SDK freezes `systemPrompt` + tool
// config at query() start (no mid-session reset — proven live, research
// wf_3199bde6), so we key by (model, mode, systemPrompt-hash): each distinct
// system prompt and each mode (text vs native router) gets its own warm process.
// Keying by model ALONE would share one frozen-system opus session across
// RESPONSE_HANDLER/TEXT_LARGE/TEXT_MEGA, bleeding context between tiers/rooms and
// intermittently returning empty turns. Lives for the plugin's lifetime; torn
// down in dispose().
const sdkSessions = new Map<string, ClaudeSdkSession>();

/**
 * Upper bound on concurrently-cached warm sessions. Each session is a live
 * Claude Code process, so the cache must not grow without bound as distinct
 * system prompts appear. In practice only a handful of keys are hot (a few
 * tiers × the stable system-prompt prefix), but a long-lived agent whose system
 * prompt drifts could otherwise accumulate processes. When the cap is exceeded
 * the least-recently-used session is disposed (LRU: Map preserves insertion
 * order; a cache hit re-inserts to mark it most-recently-used).
 */
const MAX_SDK_SESSIONS = 8;

/** The Claude model for a given tier (planner/small can differ from large). */
function resolveSdkModel(runtime: IAgentRuntime, modelType: string): string {
  const large = getSetting(runtime, "ELIZA_CLI_CLAUDE_MODEL");
  const small = getSetting(runtime, "ELIZA_CLI_CLAUDE_PLANNER_MODEL");
  const isSmallTier = modelType === ModelType.ACTION_PLANNER || modelType === ModelType.TEXT_SMALL;
  return ((isSmallTier ? small : large) || large || "claude-opus-4-8").trim();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Lazily create + cache a warm SDK session for a (model, mode, systemPrompt).
 * `router=true` builds a native `route_action` MCP-tool session (the planner);
 * `router=false` builds a plain text-generation session (reply/large tiers).
 */
function claudeSessionKey(model: string, systemPrompt: string, router: boolean): string {
  return `${model}\u001f${router ? "route" : "text"}\u001f${shortHash(systemPrompt)}`;
}

/**
 * Evict + dispose a warm Claude SDK session by its cache key so the NEXT
 * `getSdkSession` for that key spins up a fresh process — which re-reads the
 * (rotated) `CLAUDE_CODE_OAUTH_TOKEN` / `~/.claude` credential. Used by account
 * rotation after a subscription limit. Best-effort: dispose is fire-and-forget.
 */
function evictSdkSession(key: string): void {
  const existing = sdkSessions.get(key);
  if (!existing) return;
  sdkSessions.delete(key);
  void existing.dispose();
}

function getSdkSession(
  runtime: IAgentRuntime,
  model: string,
  systemPrompt: string,
  router: boolean,
  subprocessEnv?: RotationSubprocessEnv
): ClaudeSdkSession {
  const key = claudeSessionKey(model, systemPrompt, router);
  const existing = sdkSessions.get(key);
  if (existing) {
    // Mark most-recently-used: delete + re-insert moves it to the Map's tail.
    sdkSessions.delete(key);
    sdkSessions.set(key, existing);
    return existing;
  }
  const session = new ClaudeSdkSession({
    model,
    systemPrompt,
    router,
    claudeExecutablePath: getSetting(runtime, "ELIZA_CLI_CLAUDE_BIN"),
    restartAfterTurns: parseTimeout(getSetting(runtime, "ELIZA_CLI_SDK_RESTART_AFTER_TURNS")),
    turnTimeoutMs:
      parseTimeout(getSetting(runtime, "ELIZA_CLI_SDK_TURN_TIMEOUT_MS")) ??
      parseTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
    subprocessEnv,
  });
  sdkSessions.set(key, session);
  // Evict least-recently-used past the cap (each session is a live process).
  // dispose() is best-effort fire-and-forget — the new session is already
  // cached and returned synchronously.
  while (sdkSessions.size > MAX_SDK_SESSIONS) {
    const lruKey = sdkSessions.keys().next().value as string | undefined;
    if (lruKey === undefined) break;
    const lru = sdkSessions.get(lruKey);
    sdkSessions.delete(lruKey);
    void lru?.dispose();
  }
  return session;
}

/** Tear down all warm SDK sessions (plugin dispose). */
export async function disposeSdkSessions(): Promise<void> {
  const all = [...sdkSessions.values()];
  sdkSessions.clear();
  await Promise.all(all.map((s) => s.dispose()));
  const codex = [...codexSdkSessions.values()];
  codexSdkSessions.clear();
  for (const s of codex) s.dispose();
}

// Warm Codex SDK threads, keyed by (model, mode). codex-sdk has no thread-level
// system prompt (it's folded into the body), so ONE warm thread per (model, mode)
// serves every system prompt — simpler than the claude cache.
const codexSdkSessions = new Map<string, CodexSdkSession>();

/** The codex model for a given tier (planner/small can differ from large). */
function resolveCodexModel(runtime: IAgentRuntime, modelType: string): string {
  const large = getSetting(runtime, "ELIZA_CLI_CODEX_MODEL");
  const small = getSetting(runtime, "ELIZA_CLI_CODEX_PLANNER_MODEL");
  const isSmallTier = modelType === ModelType.ACTION_PLANNER || modelType === ModelType.TEXT_SMALL;
  return ((isSmallTier ? small : large) || large || "gpt-5.5").trim();
}

function codexSessionKey(model: string, router: boolean): string {
  return `${model}\u001f${router ? "route" : "text"}`;
}

/**
 * Evict + dispose a warm Codex SDK thread by its cache key so the next
 * `getCodexSdkSession` re-starts it — re-reading the (rotated) per-account
 * `CODEX_HOME`. Used by account rotation after a subscription limit.
 */
function evictCodexSdkSession(key: string): void {
  const existing = codexSdkSessions.get(key);
  if (!existing) return;
  codexSdkSessions.delete(key);
  existing.dispose();
}

/** Lazily create + cache a warm Codex SDK thread for a (model, mode). */
function getCodexSdkSession(
  runtime: IAgentRuntime,
  model: string,
  router: boolean,
  subprocessEnv?: RotationSubprocessEnv
): CodexSdkSession {
  const key = codexSessionKey(model, router);
  let session = codexSdkSessions.get(key);
  if (!session) {
    session = new CodexSdkSession({
      model,
      router,
      reasoningEffort: getSetting(runtime, "ELIZA_CLI_CODEX_REASONING_EFFORT"),
      codexBinPath: getSetting(runtime, "ELIZA_CLI_CODEX_BIN"),
      restartAfterTurns: parseTimeout(getSetting(runtime, "ELIZA_CLI_SDK_RESTART_AFTER_TURNS")),
      subprocessEnv,
    });
    codexSdkSessions.set(key, session);
  }
  return session;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// One binary setting covers both warm and cold backends so container images can
// pin executables outside the launcher allowlist. Blank settings retain the
// allowlisted PATH lookup used by unmanaged installations.
function resolveBinaryPin(runtime: IAgentRuntime, key: string): string | undefined {
  const value = getSetting(runtime, key)?.trim();
  return value ? value : undefined;
}

function buildClaude(runtime: IAgentRuntime): ClaudeCli {
  return new ClaudeCli({
    model: getSetting(runtime, "ELIZA_CLI_CLAUDE_MODEL"),
    timeoutMs: parseTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
    binaryPath: resolveBinaryPin(runtime, "ELIZA_CLI_CLAUDE_BIN"),
  });
}

function buildCodex(runtime: IAgentRuntime): CodexCli {
  return new CodexCli({
    model: getSetting(runtime, "ELIZA_CLI_CODEX_MODEL"),
    timeoutMs: parseTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
    binaryPath: resolveBinaryPin(runtime, "ELIZA_CLI_CODEX_BIN"),
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
    throw new Error(
      "[cli-inference] ELIZA_CHAT_VIA_CLI is not set to claude|claude-sdk|codex|codex-sdk"
    );
  }
  const generateParams = {
    system: params.system,
    prompt: params.prompt,
    messages: params.messages,
  };
  logger.debug(`[cli-inference] ${modelType} via ${backend}`);
  if (backend === "claude-sdk") {
    // Warm, persistent Agent SDK session. The SDK freezes `systemPrompt` at start,
    // so we flatten system+messages here and hand the session a STABLE system
    // (so all turns of a tier share one warm process) plus a self-contained body.
    const model = resolveSdkModel(runtime, modelType);
    const { system, body } = flattenPrompt(generateParams);
    // Reframe the agentic SDK model as a pure completion engine (system) AND close
    // the body with a directive that cancels any stale "call a tool" instruction,
    // so it synthesizes the final reply from already-executed tool results instead
    // of narrating intent ("I'll fetch it…"). Both are needed (proven live: 4/4 vs
    // 2/4). Keying by the framed system keeps one warm process per tier.
    const framedSystem = frameTextSystemPrompt(system);
    const framedBody = appendTextDirective(body);
    const key = claudeSessionKey(model, framedSystem, false);
    // Pool-first auth: the FIRST warm session already auths as a healthy pooled
    // Claude account when one exists (ambient ~/.claude is the fallback). On a
    // subscription limit, rotate to the next healthy pooled account (evicting
    // the warm session so it re-auths as the new account), then retry; fall
    // through to provider failover only when the pool is exhausted.
    return withAccountRotation(
      (env) => getSdkSession(runtime, model, framedSystem, false, env).generate(framedBody),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictSdkSession(key),
      }
    );
  }
  if (backend === "codex-sdk") {
    // Warm Codex SDK thread. codex-sdk folds the system into the body, so frame
    // the body the same way (the SDK model is agentic too) and run TEXT mode.
    const model = resolveCodexModel(runtime, modelType);
    const { system, body } = flattenPrompt(generateParams);
    const framedBody = appendTextDirective(`${frameTextSystemPrompt(system)}\n\n${body}`);
    const key = codexSessionKey(model, false);
    return withAccountRotation(
      (env) => getCodexSdkSession(runtime, model, false, env).generate(framedBody),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictCodexSdkSession(key),
      }
    );
  }
  const cli = backend === "claude" ? buildClaude(runtime) : buildCodex(runtime);
  return cli.generate(generateParams);
}

/**
 * ACTION_PLANNER handler for the SAFE/CLI route.
 *
 * Two implementations, picked by backend:
 *
 *  - **claude-sdk (native router):** the model is given ONE in-process MCP tool
 *    (`route_action`) and emits a real `tool_use` the warm session captures as
 *    `{action, params}`. This matches the stealth/native path's full
 *    functionality (live-info → WEB_FETCH, sub-agents) with no free-text JSON
 *    parsing and no required-tool retry loop. The per-turn action menu +
 *    transcript + persona ride in the BODY (system stays the constant
 *    `ROUTER_SYSTEM_PROMPT` so one warm process serves every planner turn).
 *
 *  - **claude / codex CLI:** the free-text CLI cannot honor native tools, so we
 *    rebuild the call into the proven CLEAN text-routing form (pick ONE action,
 *    emit compact `{action, params}` JSON) via `buildCleanRoutingParams`.
 *
 * Both return the bare `{action, params}` shape the loop's text-mode parser
 * (`parseJsonPlannerOutput` → `normalizeBarePlannerAction`) accepts directly, so
 * no core change is needed.
 */
async function planViaCli(runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> {
  const backend = resolveCliBackend({
    ELIZA_CHAT_VIA_CLI: getSetting(runtime, "ELIZA_CHAT_VIA_CLI"),
  });
  if (backend === "claude-sdk") {
    const model = resolveSdkModel(runtime, ModelType.ACTION_PLANNER);
    const routerBody = buildRouterBody(params);
    const key = claudeSessionKey(model, ROUTER_SYSTEM_PROMPT, true);
    return withAccountRotation(
      (env) => getSdkSession(runtime, model, ROUTER_SYSTEM_PROMPT, true, env).route(routerBody),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictSdkSession(key),
      }
    );
  }
  if (backend === "codex-sdk") {
    // codex routes via NATIVE structured output (outputSchema) for a reliable
    // {action, params} shape. The clean-routing prompt (menu + transcript +
    // persona) is folded into the body (codex-sdk has no thread-level system
    // prompt); the session applies the schema + parses the result.
    const model = resolveCodexModel(runtime, ModelType.ACTION_PLANNER);
    const clean = buildCleanRoutingParams(params);
    const routeBody = `${clean.system ?? ""}\n\n${clean.prompt ?? ""}`;
    const key = codexSessionKey(model, true);
    return withAccountRotation(
      (env) => getCodexSdkSession(runtime, model, true, env).route(routeBody),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictCodexSdkSession(key),
      }
    );
  }
  return generateViaCli(runtime, buildCleanRoutingParams(params), ModelType.ACTION_PLANNER);
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
  if (textPlannerEnabled()) {
    for (const modelType of PLANNER_MODEL_TYPES) {
      models[modelType] = (runtime, params) => planViaCli(runtime, params);
    }
  }
  return models as Plugin["models"];
}

export const cliInferencePlugin: Plugin = {
  name: "cli-inference",
  description:
    "TOS-clean SAFE/CLOUD inference: serves large-tier model handlers through sanctioned claude, claude-sdk, or codex routes; each route reads its own creds. Inert unless ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex.",
  // High priority so that, when ELIZA_CHAT_VIA_CLI is set, this plugin
  // deterministically wins the tiers it registers (TEXT_LARGE / TEXT_MEGA /
  // RESPONSE_HANDLER) over default-priority (0) model providers like
  // plugin-anthropic that would otherwise tie and resolve non-deterministically.
  priority: 100,
  config: {
    ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") ?? null,
    ELIZA_CLI_CLAUDE_MODEL: readEnv("ELIZA_CLI_CLAUDE_MODEL") ?? null,
    ELIZA_CLI_CLAUDE_PLANNER_MODEL: readEnv("ELIZA_CLI_CLAUDE_PLANNER_MODEL") ?? null,
    ELIZA_CLI_CLAUDE_BIN: readEnv("ELIZA_CLI_CLAUDE_BIN") ?? null,
    ELIZA_CLI_SDK_RESTART_AFTER_TURNS: readEnv("ELIZA_CLI_SDK_RESTART_AFTER_TURNS") ?? null,
    ELIZA_CLI_SDK_TURN_TIMEOUT_MS: readEnv("ELIZA_CLI_SDK_TURN_TIMEOUT_MS") ?? null,
    ELIZA_CLI_CODEX_MODEL: readEnv("ELIZA_CLI_CODEX_MODEL") ?? null,
    ELIZA_CLI_CODEX_BIN: readEnv("ELIZA_CLI_CODEX_BIN") ?? null,
    ELIZA_CLI_TIMEOUT_MS: readEnv("ELIZA_CLI_TIMEOUT_MS") ?? null,
    ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION: readEnv("ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION") ?? null,
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
    if ((backend === "claude" || backend === "claude-sdk") && stealthOn) {
      throw new Error(
        `[cli-inference] ELIZA_CHAT_VIA_CLI=${backend} collides with ELIZA_ENABLE_CLAUDE_STEALTH. ` +
          "Pick one claude inference route (CLI/SDK spawn vs in-process stealth interceptor)."
      );
    }
    logger.info(
      backend === "claude-sdk"
        ? "[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=claude-sdk — WARM Agent SDK sessions (TOS-clean, sanctioned, fast)"
        : `[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=${backend} — large-tier handlers spawn the ${backend} CLI`
    );
    if (textPlannerEnabled()) {
      logger.info(
        "[cli-inference] text-planner mode (ELIZA_PLANNER_NATIVE_TOOLS=0) — ACTION_PLANNER also served via this route (standalone SAFE stack)"
      );
    }
    if ((backend === "claude-sdk" || backend === "codex-sdk") && rotationEnabled(readEnv)) {
      logger.info(
        "[cli-inference] multi-account rotation ON — a subscription limit rotates to the next healthy pooled account before provider failover (opt out: ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION=0)"
      );
    }
  },
  async dispose(): Promise<void> {
    await disposeSdkSessions();
  },
  models: buildModels(),
};

export {
  buildRotatedSubprocessEnv,
  isSubscriptionLimitError,
  rotationAgentTypeForBackend,
  rotationEnabled,
  withAccountRotation,
} from "./src/account-rotation";
export { ClaudeCli } from "./src/claude-cli";
export { ClaudeSdkSession } from "./src/claude-sdk-session";
export {
  appendTextDirective,
  buildCleanRoutingBody,
  buildCleanRoutingParams,
  buildCleanRoutingSystemPrompt,
  buildRouterBody,
  frameTextSystemPrompt,
  ROUTER_SYSTEM_PROMPT,
  TEXT_COMPLETION_DIRECTIVE,
  TEXT_COMPLETION_FRAMING,
} from "./src/clean-routing-planner";
export { CodexCli, parseCodexJsonl } from "./src/codex-cli-exec";
export { CodexSdkSession } from "./src/codex-sdk-session";
export { flattenPrompt } from "./src/prompt-flatten";
export { LARGE_TIER_MODEL_TYPES, PLANNER_MODEL_TYPES, textPlannerEnabled };

export default cliInferencePlugin;
