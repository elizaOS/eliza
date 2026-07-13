/**
 * Validated read/write surface for user-configurable models behind the
 * authenticated control API. `POST /api/models/config` checks every request
 * against the provider→model→efforts catalog (model-catalog.ts) before
 * touching config — Codex silently accepts an invalid
 * `model_reasoning_effort`, so this route is the enforcement seam — then
 * persists the selection to all three config seams at once:
 * `config.env.vars[KEY]`, `config.env[KEY]` (the section the orchestrator's
 * `readConfigEnvKey` re-reads per spawn), and `process.env[KEY]`.
 *
 * Chat-brain targets (small/large) require a runtime restart for the model
 * plugin to pick up the new ids, driven through the same idempotent
 * RuntimeOperationManager the provider-switch route uses — the config write
 * happens inside the operation's prepare step so a busy runtime rejects
 * without a half-applied config. Coding targets return without restart:
 * sub-agent spawns re-read the config env on every spawn. A coding write may
 * also be a defaultBackend-only body (no `model`), persisting just
 * ELIZA_DEFAULT_AGENT_TYPE — the seam the `/backend` slash command drives.
 * When a touched key
 * already carried a different process-env value that the config did not put
 * there (systemd service.env, shell export), the response lists it in
 * `conflictingServiceEnvKeys` as an honest warning — a full service restart
 * may resurrect the external value.
 *
 * `GET /api/models/config` reports the current effective value for every key
 * this route owns, with the source that won (`config.env` → `config.env.vars`
 * → `process.env`, mirroring the orchestrator's direct-section-first read).
 */
import {
  ElizaError,
  logger,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/core";
import {
  DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import type { RuntimeOperationManager } from "../runtime/operations/index.ts";
import {
  buildModelCatalog,
  CODING_MODEL_DEFAULTS,
  type ModelCatalog,
  type ModelCatalogEntry,
} from "./model-catalog.ts";

export type ModelConfigTarget = "small" | "large" | "coding";
export type CodingBackend = "codex" | "claude" | "opencode" | "eliza-code";

export interface ModelConfigWriteBody {
  target: ModelConfigTarget;
  provider?: string;
  backend?: CodingBackend;
  /** Omittable only for the defaultBackend-only coding switch. */
  model?: string;
  effort?: string;
  /** Optional coding-backend switch, persisted as ELIZA_DEFAULT_AGENT_TYPE. */
  defaultBackend?: CodingBackend;
}

export interface ModelConfigRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "readJsonBody"> {
  state: { config: ElizaConfig };
  saveElizaConfig: (config: ElizaConfig) => void;
  runtimeOperationManager: RuntimeOperationManager;
  /** Injectable catalog for tests; defaults to the live buildModelCatalog(). */
  catalog?: ModelCatalog;
  /** Injectable process env for tests; defaults to process.env. */
  processEnv?: NodeJS.ProcessEnv;
}

const TARGETS = new Set<ModelConfigTarget>(["small", "large", "coding"]);
const CODING_BACKENDS = new Set<CodingBackend>([
  "codex",
  "claude",
  "opencode",
  "eliza-code",
]);

// Chat providers → the env-var family the corresponding model plugin reads.
// cerebras serves through plugin-openai's Cerebras mode (OPENAI_*), but
// elizacloud serves through plugin-elizacloud, which reads only the
// ELIZAOS_CLOUD_* keys — under cloud-proxy routing the plugin-collector
// removes plugin-openai entirely, so an OPENAI_* write for the elizacloud
// provider would be silently inert.
type ChatKeyFamily = "OPENAI" | "ANTHROPIC" | "ELIZAOS_CLOUD";
const CHAT_PROVIDER_KEY_FAMILY: Record<string, ChatKeyFamily> = {
  cerebras: "OPENAI",
  elizacloud: "ELIZAOS_CLOUD",
  "claude-chat": "ANTHROPIC",
};

// serviceRouting.llmText backend ids → the catalog chat provider that serves
// them. "anthropic" is the provider-switch id; the catalog names that brain
// "claude-chat".
const LLM_BACKEND_TO_CHAT_PROVIDER: Record<string, string> = {
  cerebras: "cerebras",
  elizacloud: "elizacloud",
  anthropic: "claude-chat",
};

interface CodingBackendSeam {
  modelKey: string;
  /** null = the backend has no effort seam; sending effort is a 400. */
  effortKey: string | null;
  /** Catalog provider to validate against; null = free-form model string. */
  catalogProvider: string | null;
}

// Model keys are the `powerful` slots of TASK_AGENT_MODEL_PREF_SETTING_KEYS
// (plugin-agent-orchestrator/src/services/task-agent-frameworks.ts) — the keys
// spawns actually read. The effort keys are persisted now; the CLI adapters
// grow their consumers in a follow-on wiring change.
const CODING_BACKEND_SEAMS: Record<CodingBackend, CodingBackendSeam> = {
  codex: {
    modelKey: "ELIZA_CODEX_MODEL_POWERFUL",
    effortKey: "ELIZA_CODEX_EFFORT",
    catalogProvider: "codex",
  },
  claude: {
    modelKey: "ELIZA_CLAUDE_MODEL_POWERFUL",
    effortKey: "ELIZA_CLAUDE_EFFORT",
    catalogProvider: "claude-coding",
  },
  opencode: {
    modelKey: "ELIZA_OPENCODE_MODEL_POWERFUL",
    effortKey: null,
    catalogProvider: null,
  },
  "eliza-code": {
    modelKey: "ELIZA_ELIZAOS_MODEL_POWERFUL",
    effortKey: null,
    catalogProvider: null,
  },
};

// The orchestrator's KNOWN_ADAPTER_TYPES spells the in-house backend
// "elizaos"; persisting the API's "eliza-code" literal would be silently
// dropped by its adapter normalization.
const DEFAULT_BACKEND_PERSISTED_VALUE: Record<CodingBackend, string> = {
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
  "eliza-code": "elizaos",
};

function invalid(
  message: string,
  context: Record<string, unknown>,
): ElizaError {
  return new ElizaError(message, {
    code: "MODEL_CONFIG_INVALID",
    context,
    severity: "ephemeral",
  });
}

function findEntry(
  catalog: ModelCatalog,
  provider: string,
  model: string,
): ModelCatalogEntry | undefined {
  return catalog.providers[provider]?.find((entry) => entry.id === model);
}

// Keep this aligned with MANAGED_CODEX_ACP_EFFORTS in app-core's
// coding-account-bridge.ts. The model catalog may advertise newer effort
// variants before the managed Codex ACP spawn path supports them end to end;
// accepting one here would persist a selection the coding backend cannot honor.
const MANAGED_CODEX_ACP_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
]);

function validateEffort(entry: ModelCatalogEntry, effort: string): void {
  if (entry.efforts.length === 0) {
    throw invalid(`Model "${entry.id}" exposes no effort control`, {
      model: entry.id,
      effort,
    });
  }
  if (!entry.efforts.includes(effort)) {
    throw invalid(
      `Effort "${effort}" is not supported by model "${entry.id}" (supported: ${entry.efforts.join(", ")})`,
      { model: entry.id, effort, supported: entry.efforts },
    );
  }
}

function ensureEnvSections(config: ElizaConfig): {
  direct: Record<string, unknown>;
  vars: Record<string, string>;
} {
  const record = config as Record<string, unknown>;
  if (
    !record.env ||
    typeof record.env !== "object" ||
    Array.isArray(record.env)
  ) {
    record.env = {};
  }
  const direct = record.env as Record<string, unknown>;
  if (
    !direct.vars ||
    typeof direct.vars !== "object" ||
    Array.isArray(direct.vars)
  ) {
    direct.vars = {};
  }
  return { direct, vars: direct.vars as Record<string, string> };
}

function readConfigEnvString(
  config: ElizaConfig,
  key: string,
): { value: string; source: "config.env" | "config.env.vars" } | null {
  const env = (config as Record<string, unknown>).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const direct = (env as Record<string, unknown>)[key];
  if (typeof direct === "string" && direct.trim()) {
    return { value: direct, source: "config.env" };
  }
  const vars = (env as Record<string, unknown>).vars;
  if (vars && typeof vars === "object" && !Array.isArray(vars)) {
    const nested = (vars as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim()) {
      return { value: nested, source: "config.env.vars" };
    }
  }
  return null;
}

/**
 * Write one key to all three seams. Returns true when process.env already
 * carried a different value that the config did not put there — i.e. it came
 * from an external source (systemd service.env, shell export) that a full
 * service restart may re-apply over this save.
 */
function writeModelEnvKey(
  config: ElizaConfig,
  processEnv: NodeJS.ProcessEnv,
  key: string,
  value: string,
): boolean {
  const priorProcess = processEnv[key];
  const priorConfig = readConfigEnvString(config, key)?.value;
  const { direct, vars } = ensureEnvSections(config);
  direct[key] = value;
  vars[key] = value;
  processEnv[key] = value;
  return (
    typeof priorProcess === "string" &&
    priorProcess !== value &&
    priorProcess !== priorConfig
  );
}

interface ResolvedWrite {
  key: string;
  value: string;
}

function resolveChatWrites(
  catalog: ModelCatalog,
  body: ModelConfigWriteBody,
  activeProvider?: string,
): ResolvedWrite[] {
  if (body.backend !== undefined) {
    throw invalid(
      `backend is a coding-target field; target "${body.target}" selects a chat provider`,
      { target: body.target, backend: body.backend },
    );
  }
  // parseWriteBody only omits `model` for the defaultBackend-only coding
  // shape; re-assert here so the chat path stays typed on a plain string.
  const model = body.model;
  if (model === undefined) {
    throw invalid("model must be a non-empty string", { model: null });
  }

  let provider = body.provider;
  if (provider !== undefined && !(provider in CHAT_PROVIDER_KEY_FAMILY)) {
    throw invalid(
      `Unknown chat provider "${provider}" (expected one of: ${Object.keys(CHAT_PROVIDER_KEY_FAMILY).join(", ")})`,
      { provider },
    );
  }
  if (provider === undefined) {
    const matches = Object.keys(CHAT_PROVIDER_KEY_FAMILY).filter((candidate) =>
      findEntry(catalog, candidate, model)?.roles.includes(
        body.target as "small" | "large",
      ),
    );
    if (matches.length === 0) {
      throw invalid(`Unknown model "${model}" for target "${body.target}"`, {
        model,
        target: body.target,
      });
    }
    if (matches.length > 1) {
      // The Cerebras trio is offered by both cerebras (direct) and elizacloud
      // (proxied) — a bare `/model small gemma-4-31b` must land on whichever
      // brain is actually serving chat, not 400 on the overlap.
      if (activeProvider !== undefined && matches.includes(activeProvider)) {
        provider = activeProvider;
      } else {
        throw invalid(
          `Model "${model}" is served by multiple providers (${matches.join(", ")}); specify provider`,
          { model, providers: matches },
        );
      }
    } else {
      provider = matches[0] as string;
    }
  }

  const entry = findEntry(catalog, provider, model);
  if (!entry) {
    throw invalid(`Unknown model "${model}" for provider "${provider}"`, {
      model,
      provider,
    });
  }
  if (!entry.roles.includes(body.target as "small" | "large")) {
    throw invalid(
      `Model "${model}" is not offered for the "${body.target}" role on provider "${provider}"`,
      { model, provider, target: body.target, roles: entry.roles },
    );
  }

  const family = CHAT_PROVIDER_KEY_FAMILY[provider] as ChatKeyFamily;
  const targetUpper = body.target.toUpperCase();
  const writes: ResolvedWrite[] = [
    { key: `${family}_${targetUpper}_MODEL`, value: model },
  ];
  if (body.effort !== undefined) {
    validateEffort(entry, body.effort);
    writes.push(
      family === "ANTHROPIC"
        ? { key: `ANTHROPIC_EFFORT_${targetUpper}`, value: body.effort }
        : family === "ELIZAOS_CLOUD"
          ? { key: "ELIZAOS_CLOUD_REASONING_EFFORT", value: body.effort }
          : { key: "OPENAI_REASONING_EFFORT", value: body.effort },
    );
  }
  return writes;
}

function resolveCodingWrites(
  catalog: ModelCatalog,
  body: ModelConfigWriteBody,
): ResolvedWrite[] {
  // defaultBackend-only switch: no model seam is touched, so the model-write
  // fields would be silently ignored — reject their presence loudly instead.
  if (body.model === undefined) {
    if (
      body.backend !== undefined ||
      body.provider !== undefined ||
      body.effort !== undefined
    ) {
      throw invalid(
        "a defaultBackend-only write must not carry backend, provider, or effort",
        {
          backend: body.backend ?? null,
          provider: body.provider ?? null,
          effort: body.effort ?? null,
        },
      );
    }
    const writes = resolveDefaultBackendWrites(body);
    if (writes.length === 0) {
      // parseWriteBody admits the modelless shape only with a defaultBackend;
      // never let it decay into an applied-but-empty write.
      throw invalid("model must be a non-empty string", { model: null });
    }
    return writes;
  }
  const model = body.model;

  const backend = body.backend;
  if (backend === undefined || !CODING_BACKENDS.has(backend)) {
    throw invalid(
      `target "coding" requires backend (one of: ${[...CODING_BACKENDS].join(", ")})`,
      { backend: backend ?? null },
    );
  }
  const seam = CODING_BACKEND_SEAMS[backend];
  if (body.provider !== undefined && body.provider !== seam.catalogProvider) {
    throw invalid(
      `provider "${body.provider}" does not match coding backend "${backend}"`,
      { provider: body.provider, backend },
    );
  }

  if (seam.catalogProvider) {
    const entry = findEntry(catalog, seam.catalogProvider, model);
    if (!entry) {
      throw invalid(`Unknown model "${model}" for backend "${backend}"`, {
        model,
        backend,
        provider: seam.catalogProvider,
      });
    }
    if (body.effort !== undefined) {
      validateEffort(entry, body.effort);
      if (backend === "codex" && !MANAGED_CODEX_ACP_EFFORTS.has(body.effort)) {
        throw invalid(
          `Effort "${body.effort}" is valid for ${entry.id} but not supported by the managed codex-acp contract (supported: ${[...MANAGED_CODEX_ACP_EFFORTS].join(", ")})`,
          {
            model: entry.id,
            effort: body.effort,
            supported: [...MANAGED_CODEX_ACP_EFFORTS],
            reason: "codex-acp-contract",
          },
        );
      }
    }
  } else if (body.effort !== undefined) {
    throw invalid(`backend "${backend}" has no effort control`, {
      backend,
      effort: body.effort,
    });
  }

  const writes: ResolvedWrite[] = [{ key: seam.modelKey, value: model }];
  if (body.effort !== undefined && seam.effortKey) {
    writes.push({ key: seam.effortKey, value: body.effort });
  }
  writes.push(...resolveDefaultBackendWrites(body));
  return writes;
}

function resolveDefaultBackendWrites(
  body: ModelConfigWriteBody,
): ResolvedWrite[] {
  if (body.defaultBackend === undefined) return [];
  if (!CODING_BACKENDS.has(body.defaultBackend)) {
    throw invalid(`Unknown defaultBackend "${body.defaultBackend}"`, {
      defaultBackend: body.defaultBackend,
    });
  }
  return [
    {
      key: "ELIZA_DEFAULT_AGENT_TYPE",
      value: DEFAULT_BACKEND_PERSISTED_VALUE[body.defaultBackend],
    },
  ];
}

function parseWriteBody(raw: Record<string, unknown>): ModelConfigWriteBody {
  const target = raw.target;
  if (typeof target !== "string" || !TARGETS.has(target as ModelConfigTarget)) {
    throw invalid(`target must be one of: ${[...TARGETS].join(", ")}`, {
      target: target ?? null,
    });
  }
  const model = raw.model;
  // `model` may be omitted only for the defaultBackend-only coding switch;
  // every other shape validates it exactly as before.
  const defaultBackendOnly =
    target === "coding" &&
    model === undefined &&
    raw.defaultBackend !== undefined;
  if (!defaultBackendOnly && (typeof model !== "string" || !model.trim())) {
    throw invalid("model must be a non-empty string", { model: model ?? null });
  }
  const optionalString = (field: string): string | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      throw invalid(`${field} must be a non-empty string when provided`, {
        [field]: value,
      });
    }
    return value.trim();
  };
  const backend = optionalString("backend");
  if (backend !== undefined && !CODING_BACKENDS.has(backend as CodingBackend)) {
    throw invalid(
      `Unknown backend "${backend}" (expected one of: ${[...CODING_BACKENDS].join(", ")})`,
      { backend },
    );
  }
  const defaultBackend = optionalString("defaultBackend");
  if (
    defaultBackend !== undefined &&
    !CODING_BACKENDS.has(defaultBackend as CodingBackend)
  ) {
    throw invalid(
      `Unknown defaultBackend "${defaultBackend}" (expected one of: ${[...CODING_BACKENDS].join(", ")})`,
      { defaultBackend },
    );
  }
  return {
    target: target as ModelConfigTarget,
    model: typeof model === "string" ? model.trim() : undefined,
    provider: optionalString("provider"),
    backend: backend as CodingBackend | undefined,
    effort: optionalString("effort"),
    defaultBackend: defaultBackend as CodingBackend | undefined,
  };
}

type EffectiveValue = {
  value: string;
  source: "config.env" | "config.env.vars" | "process.env" | "default";
} | null;

function resolveEffective(
  config: ElizaConfig,
  processEnv: NodeJS.ProcessEnv,
  key: string,
): EffectiveValue {
  const fromConfig = readConfigEnvString(config, key);
  if (fromConfig) return fromConfig;
  const fromProcess = processEnv[key];
  if (typeof fromProcess === "string" && fromProcess.trim()) {
    return { value: fromProcess, source: "process.env" };
  }
  return null;
}

/**
 * The chat provider actually serving inference right now, resolved from the
 * canonical serviceRouting topology — the same signal the plugin-collector
 * uses to decide which model plugin loads. `endpoint` is the host that
 * answers, so operator surfaces (/model show, the settings panel) can name
 * what ACTUALLY serves instead of guessing from OPENAI_BASE_URL, which stays
 * pinned in the environment even when cloud-proxy routing makes it inert.
 */
export interface ActiveChatInfo {
  provider: string;
  family: ChatKeyFamily;
  endpoint: string;
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    // error-policy:J3 a non-URL base value can't name a host; callers fall
    // back to the provider's canonical endpoint.
    return null;
  }
}

export function resolveActiveChat(
  config: ElizaConfig,
  processEnv: NodeJS.ProcessEnv,
): ActiveChatInfo | null {
  const routing = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  );
  const llmText = routing?.llmText;
  const backend =
    typeof llmText?.backend === "string" ? llmText.backend : undefined;
  const provider =
    llmText?.transport === "cloud-proxy" && backend === "elizacloud"
      ? "elizacloud"
      : llmText?.transport === "direct" && backend !== undefined
        ? LLM_BACKEND_TO_CHAT_PROVIDER[backend]
        : undefined;
  const family =
    provider !== undefined ? CHAT_PROVIDER_KEY_FAMILY[provider] : undefined;
  if (provider === undefined || family === undefined) return null;
  const baseFor = (key: string): string | undefined =>
    resolveEffective(config, processEnv, key)?.value;
  const endpoint =
    family === "ELIZAOS_CLOUD"
      ? (hostOf(baseFor("ELIZAOS_CLOUD_BASE_URL")) ?? "elizacloud.ai")
      : family === "ANTHROPIC"
        ? (hostOf(baseFor("ANTHROPIC_BASE_URL")) ?? "api.anthropic.com")
        : (hostOf(baseFor("OPENAI_BASE_URL")) ?? "api.openai.com");
  return { provider, family, endpoint };
}

function buildEffectiveConfig(
  config: ElizaConfig,
  processEnv: NodeJS.ProcessEnv,
  activeChat: ActiveChatInfo | null,
): Record<string, Record<string, EffectiveValue>> {
  const resolve = (key: string): EffectiveValue =>
    resolveEffective(config, processEnv, key);
  // The cloud plugin falls back to a code default when no env pin exists;
  // report it (source "default") only while cloud is the active brain so the
  // panel/show never claim a cloud default is in effect under direct routing.
  const cloudModel = (target: "SMALL" | "LARGE"): EffectiveValue => {
    const pinned = resolve(`ELIZAOS_CLOUD_${target}_MODEL`);
    if (pinned) return pinned;
    if (activeChat?.family === "ELIZAOS_CLOUD") {
      return {
        value:
          target === "LARGE"
            ? DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL
            : DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
        source: "default",
      };
    }
    return null;
  };
  const chatKeys = (target: "SMALL" | "LARGE") => ({
    [`OPENAI_${target}_MODEL`]: resolve(`OPENAI_${target}_MODEL`),
    [`ANTHROPIC_${target}_MODEL`]: resolve(`ANTHROPIC_${target}_MODEL`),
    [`ELIZAOS_CLOUD_${target}_MODEL`]: cloudModel(target),
    OPENAI_REASONING_EFFORT: resolve("OPENAI_REASONING_EFFORT"),
    [`ANTHROPIC_EFFORT_${target}`]: resolve(`ANTHROPIC_EFFORT_${target}`),
    ELIZAOS_CLOUD_REASONING_EFFORT: resolve("ELIZAOS_CLOUD_REASONING_EFFORT"),
  });
  const codexDefault = CODING_MODEL_DEFAULTS.codex;
  const claudeDefault = CODING_MODEL_DEFAULTS.claude;
  return {
    small: chatKeys("SMALL"),
    large: chatKeys("LARGE"),
    coding: {
      ELIZA_DEFAULT_AGENT_TYPE: resolve("ELIZA_DEFAULT_AGENT_TYPE"),
      ELIZA_CODEX_MODEL_POWERFUL:
        resolve("ELIZA_CODEX_MODEL_POWERFUL") ??
        (codexDefault ? { value: codexDefault, source: "default" } : null),
      ELIZA_CODEX_EFFORT: resolve("ELIZA_CODEX_EFFORT"),
      ELIZA_CLAUDE_MODEL_POWERFUL:
        resolve("ELIZA_CLAUDE_MODEL_POWERFUL") ??
        (claudeDefault ? { value: claudeDefault, source: "default" } : null),
      ELIZA_CLAUDE_EFFORT: resolve("ELIZA_CLAUDE_EFFORT"),
      ELIZA_OPENCODE_MODEL_POWERFUL: resolve("ELIZA_OPENCODE_MODEL_POWERFUL"),
      ELIZA_ELIZAOS_MODEL_POWERFUL: resolve("ELIZA_ELIZAOS_MODEL_POWERFUL"),
    },
  };
}

/**
 * Handle `GET`/`POST /api/models/config`. Returns true when the request was
 * handled.
 */
export async function handleModelConfigRoutes(
  ctx: ModelConfigRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, readJsonBody } = ctx;
  if (pathname !== "/api/models/config") return false;
  const processEnv = ctx.processEnv ?? process.env;

  if (method === "GET") {
    const activeChat = resolveActiveChat(state.config, processEnv);
    json(res, {
      targets: buildEffectiveConfig(state.config, processEnv, activeChat),
      ...(activeChat ? { activeChat } : {}),
    });
    return true;
  }

  if (method !== "POST") return false;

  const raw = await readJsonBody<Record<string, unknown>>(req, res);
  if (raw === null) return true;

  try {
    const body = parseWriteBody(raw);
    const catalog = ctx.catalog ?? buildModelCatalog();

    if (body.target === "coding") {
      const writes = resolveCodingWrites(catalog, body);
      const conflicts: string[] = [];
      for (const write of writes) {
        if (
          writeModelEnvKey(state.config, processEnv, write.key, write.value)
        ) {
          conflicts.push(write.key);
        }
      }
      ctx.saveElizaConfig(state.config);
      logger.info(
        `[ModelConfigRoutes] coding model config applied: ${writes.map((w) => `${w.key}=${w.value}`).join(" ")}`,
      );
      // No restart: the orchestrator re-reads the config env section on every
      // sub-agent spawn (readConfigEnvKey), so the write is live immediately.
      json(res, {
        applied: true,
        restart: false,
        keys: writes.map((w) => w.key),
        ...(conflicts.length > 0
          ? { conflictingServiceEnvKeys: conflicts }
          : {}),
      });
      return true;
    }

    const writes = resolveChatWrites(
      catalog,
      body,
      resolveActiveChat(state.config, processEnv)?.provider,
    );
    const conflicts: string[] = [];
    const outcome = await ctx.runtimeOperationManager.start({
      intent: {
        kind: "restart",
        reason: `model-config: ${body.target} model set to ${body.model}`,
      },
      // Writing inside prepare keeps the config change atomic with operation
      // acceptance: a rejected-busy outcome leaves the config untouched.
      prepare: async () => {
        for (const write of writes) {
          if (
            writeModelEnvKey(state.config, processEnv, write.key, write.value)
          ) {
            conflicts.push(write.key);
          }
        }
        ctx.saveElizaConfig(state.config);
        return undefined;
      },
    });

    if (outcome.kind === "rejected-busy") {
      json(
        res,
        {
          error: "A runtime operation is already in progress",
          activeOperationId: outcome.activeOperationId,
        },
        409,
      );
      return true;
    }

    logger.info(
      `[ModelConfigRoutes] ${body.target} model config applied: ${writes.map((w) => `${w.key}=${w.value}`).join(" ")} op=${outcome.operation.id}`,
    );
    json(res, {
      applied: outcome.kind === "accepted",
      restart: true,
      operationId: outcome.operation.id,
      keys: writes.map((w) => w.key),
      ...(outcome.kind === "deduped" ? { deduped: true } : {}),
      ...(conflicts.length > 0 ? { conflictingServiceEnvKeys: conflicts } : {}),
    });
    return true;
  } catch (err) {
    // error-policy:J1 route transport boundary — translate the typed
    // validation failure into a structured 400 and anything else into a 500.
    if (err instanceof ElizaError) {
      json(
        res,
        { error: err.message, code: err.code, context: err.context },
        400,
      );
      return true;
    }
    logger.error(
      `[ModelConfigRoutes] model config write failed: ${err instanceof Error ? err.stack : String(err)}`,
    );
    json(res, { error: "Model config update failed" }, 500);
    return true;
  }
}
