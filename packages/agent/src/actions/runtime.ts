/**
 * RUNTIME — single polymorphic entry point for runtime control + introspection.
 *
 * Ops:
 *   - status           in-process snapshot of agent + counts
 *   - self_status      Layer-2 detail from the Self-Awareness System (folds in GET_SELF_STATUS)
 *   - describe_actions in-process listing of registered actions, optionally filtered
 *                      (alias: list_actions)
 *   - reload_config    POST /api/config/reload — reapplies hot-reloadable eliza.json fields
 *   - restart          requests a process restart via the registered RestartHandler.
 *                      When invoked from a chat turn the handler verifies the user
 *                      explicitly asked for it and persists a "Restarting…" memory;
 *                      non-chat callers need branded internal provenance.
 *
 * @module actions/runtime
 */

import crypto from "node:crypto";
import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { logger, toWellFormedUnicode } from "@elizaos/core";
import {
  type AwarenessRegistry,
  createSelfApiRequestHeaders,
  getValidationKeywordTerms,
  isSelfEditEnabled,
  requestRestart,
  resolveServerOnlyPort,
  textIncludesKeywordTerm,
} from "@elizaos/shared";

const RUNTIME_OPS = [
  "status",
  "self_status",
  "describe_actions",
  "reload_config",
  "restart",
] as const;

type RuntimeOp = (typeof RUNTIME_OPS)[number];

// `list_actions` is accepted as an alias of `describe_actions` so older
// inbound callers that wrote the previous name continue to work.
const OP_ALIASES: Record<string, RuntimeOp> = {
  list_actions: "describe_actions",
  // `restart_agent` was the legacy name for the user-validated restart op;
  // it now flows through `restart` like any other restart request.
  restart_agent: "restart",
};

const RESTART_SOURCES = ["self-edit", "user", "plugin-install"] as const;
type RestartSource = (typeof RESTART_SOURCES)[number];
type TrustedInternalRestartSource = Exclude<RestartSource, "user">;

const TRUSTED_INTERNAL_RESTART = Symbol("trusted-internal-runtime-restart");

/**
 * Non-planner restart provenance accepted only when minted by
 * {@link createTrustedRuntimeRestartRequest}. JSON/tool parameters cannot carry
 * the module-private symbol checked at the handler boundary.
 */
export interface TrustedRuntimeRestartRequest {
  readonly source: TrustedInternalRestartSource;
  readonly reason?: string;
}

type BrandedTrustedRuntimeRestartRequest = TrustedRuntimeRestartRequest & {
  readonly [TRUSTED_INTERNAL_RESTART]: true;
};

export function createTrustedRuntimeRestartRequest(
  source: TrustedInternalRestartSource,
  reason?: string,
): TrustedRuntimeRestartRequest {
  return Object.freeze({
    source,
    ...(reason !== undefined ? { reason } : {}),
    [TRUSTED_INTERNAL_RESTART]: true,
  });
}

function readTrustedRuntimeRestartRequest(
  value: unknown,
): BrandedTrustedRuntimeRestartRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const request = value as Partial<BrandedTrustedRuntimeRestartRequest>;
  return request[TRUSTED_INTERNAL_RESTART] === true &&
    (request.source === "self-edit" || request.source === "plugin-install")
    ? (request as BrandedTrustedRuntimeRestartRequest)
    : null;
}

interface RuntimeHandlerOptions extends HandlerOptions {
  trustedRestart?: TrustedRuntimeRestartRequest;
}

const SELF_STATUS_MODULES = [
  "all",
  "runtime",
  "permissions",
  "wallet",
  "provider",
  "pluginHealth",
  "connectors",
  "cloud",
  "features",
] as const;
type SelfStatusModule = (typeof SELF_STATUS_MODULES)[number];

interface RuntimeParams {
  action?: string;
  subaction?: string;
  op?: string;
  view?: "summary" | "counts";
  filter?: string;
  reason?: string;
  source?: RestartSource;
  module?: string;
  detailLevel?: "brief" | "full";
}

/** Small delay (ms) before restarting so the response has time to flush. */
const SHUTDOWN_DELAY_MS = 1_500;

const RESTART_REQUEST_TERMS = getValidationKeywordTerms(
  "action.restart.request",
  { includeAllLocales: true },
);

function normalizeOp(value: string): RuntimeOp | null {
  if ((RUNTIME_OPS as readonly string[]).includes(value)) {
    return value as RuntimeOp;
  }
  if (Object.hasOwn(OP_ALIASES, value)) {
    return OP_ALIASES[value];
  }
  return null;
}

function isSelfStatusModule(value: string): value is SelfStatusModule {
  return (SELF_STATUS_MODULES as readonly string[]).includes(value);
}

function isAwarenessRegistry(value: unknown): value is AwarenessRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    "getDetail" in value &&
    typeof (value as { getDetail?: unknown }).getDetail === "function"
  );
}

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

function isExplicitRestartRequest(message: Memory | undefined): boolean {
  const text = (message?.content?.text ?? "").trim();
  if (!text) return false;
  if (text.toLowerCase().startsWith("/restart")) return true;
  return RESTART_REQUEST_TERMS.some((term) =>
    textIncludesKeywordTerm(text, term),
  );
}

function fail(op: RuntimeOp | "unknown", text: string): ActionResult {
  const code = `RUNTIME_${op.toUpperCase()}_FAILED`;
  return {
    success: false,
    text,
    values: { error: code, op },
    data: { actionName: "RUNTIME", op, error: code },
  };
}

function statusOp(runtime: IAgentRuntime, params: RuntimeParams): ActionResult {
  const view = params.view === "counts" ? "counts" : "summary";
  const actionCount = runtime.actions.length;
  const providerCount = runtime.providers.length;
  const services = runtime.services as Map<string, unknown[]> | undefined;
  let serviceCount = 0;
  if (services) {
    for (const list of services.values()) {
      serviceCount += list.length;
    }
  }
  const character = runtime.character;
  const agentName = character.name ?? "unknown";
  const model =
    (character.settings?.MODEL_PROVIDER as string | undefined) ??
    (character.settings?.model as string | undefined) ??
    null;
  const generatedAt = new Date().toISOString();
  const countLine = `Actions: ${actionCount}, Providers: ${providerCount}, Services: ${serviceCount}`;
  const lines =
    view === "counts"
      ? [countLine]
      : [
          `Agent: ${agentName}`,
          `Model: ${model ?? "n/a"}`,
          countLine,
          `Generated: ${generatedAt}`,
        ];
  return {
    success: true,
    text: lines.join("\n"),
    values: { actionCount, providerCount, serviceCount },
    data: {
      actionName: "RUNTIME",
      op: "status",
      view,
      snapshot: {
        agentName,
        agentId: runtime.agentId,
        model,
        actionCount,
        providerCount,
        serviceCount,
        generatedAt,
      },
    },
  };
}

async function selfStatusOp(
  runtime: IAgentRuntime,
  params: RuntimeParams,
): Promise<ActionResult> {
  const service = runtime.getService("AWARENESS_REGISTRY");
  const registry = isAwarenessRegistry(service) ? service : null;
  if (!registry) {
    // error-policy:J4 designed degrade — the awareness registry is an
    // optional enrichment; without it the live runtime status snapshot is
    // still a real answer. Hard-failing here fed the planner's failed-tool
    // fallback for simple self-description questions (live incident: "what
    // are your app-build routing rules?" answered with a generic apology).
    const snapshot = statusOp(runtime, params);
    return {
      ...snapshot,
      text: `Self-awareness registry is not loaded; answering from the live runtime status snapshot instead.\n${snapshot.text ?? ""}`,
    };
  }

  const rawModule = typeof params.module === "string" ? params.module : "all";
  const module: SelfStatusModule = isSelfStatusModule(rawModule)
    ? rawModule
    : "all";
  const detailLevel = params.detailLevel === "full" ? "full" : "brief";

  const rawText = await registry.getDetail(runtime, module, detailLevel);
  const text = toWellFormedUnicode(rawText);
  return {
    success: true,
    text,
    values: { module, detailLevel },
    data: {
      actionName: "RUNTIME",
      op: "self_status",
      module,
      detailLevel,
      truncated: false,
    },
  };
}

function describeActionsOp(
  runtime: IAgentRuntime,
  params: RuntimeParams,
): ActionResult {
  const filterRaw = params.filter?.trim() ?? "";
  const filter = filterRaw.toLowerCase();
  const all = runtime.actions;
  const matched = filter
    ? all.filter((action) => action.name.toLowerCase().includes(filter))
    : [...all];
  matched.sort((a, b) => a.name.localeCompare(b.name));
  const lines = matched.map((action) => {
    const description = action.description.trim();
    return `${action.name}${description ? ` — ${description}` : ""}`;
  });
  const header = filter
    ? `Found ${matched.length} action(s) matching "${filterRaw}".`
    : `Registered ${matched.length} action(s).`;
  return {
    success: true,
    text: [header, "", ...lines].join("\n"),
    values: { count: matched.length, totalRegistered: all.length },
    data: {
      actionName: "RUNTIME",
      op: "describe_actions",
      filter: filterRaw,
      actions: matched.map((action) => ({
        name: action.name,
        description: action.description,
        similes: action.similes ?? [],
      })),
    },
  };
}

interface ReloadConfigResponse {
  reloaded?: boolean;
  applied?: string[];
  requiresRestart?: string[];
}

async function reloadConfigOp(): Promise<ActionResult> {
  // The route handler owns ConfigRouteContext (state.config, isBlockedEnvKey)
  // and the diff/apply helpers are file-private. Until those are extracted to
  // a service, this op stays HTTP-backed.
  try {
    const resp = await fetch(`${getApiBase()}/api/config/reload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...createSelfApiRequestHeaders(),
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errBody = (await resp.json()) as { error?: string };
        if (errBody.error) detail = errBody.error;
      } catch {
        // body wasn't JSON; keep status text
      }
      return fail("reload_config", `Config reload failed: ${detail}`);
    }
    const data = (await resp.json()) as ReloadConfigResponse;
    const applied = data.applied ?? [];
    const requiresRestart = data.requiresRestart ?? [];
    const lines = [
      applied.length
        ? `Applied: ${applied.join(", ")}`
        : "No hot-reloadable fields changed.",
    ];
    if (requiresRestart.length) {
      lines.push(
        `Restart required for: ${requiresRestart.join(", ")} (run RUNTIME op=restart).`,
      );
    }
    return {
      success: true,
      text: lines.join("\n"),
      values: {
        applied,
        requiresRestart,
        restartNeeded: requiresRestart.length > 0,
      },
      data: { actionName: "RUNTIME", op: "reload_config", response: data },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[runtime] reload_config failed: ${msg}`);
    return fail("reload_config", `Config reload failed: ${msg}`);
  }
}

async function restartOp(
  runtime: IAgentRuntime,
  message: Memory | undefined,
  params: RuntimeParams,
  trustedRequest: BrandedTrustedRuntimeRestartRequest | null,
): Promise<ActionResult> {
  const isFromChat = isExplicitRestartRequest(message);
  if (!isFromChat && !trustedRequest) {
    return {
      success: false,
      text: "Restart refused: the owner did not explicitly request a restart and no trusted internal restart request was provided.",
      values: { error: "RESTART_INTENT_REQUIRED" },
      data: {
        actionName: "RUNTIME",
        op: "restart",
        refused: "restart-intent-required",
      },
    };
  }

  const source: RestartSource = trustedRequest?.source ?? "user";
  const rawReason = trustedRequest ? trustedRequest.reason : params.reason;
  const reason =
    typeof rawReason === "string" ? toWellFormedUnicode(rawReason) : undefined;

  // Self-edit-driven restarts must only execute when the dev-mode gate is
  // open. Other restart sources (user-issued, plugin install) bypass the gate.
  if (source === "self-edit" && !isSelfEditEnabled()) {
    const refusal =
      "Refused: self-edit restart requires dev mode " +
      "(ELIZA_ENABLE_SELF_EDIT=1 plus NODE_ENV!=production or ELIZA_DEV_MODE=1).";
    logger.warn(`[runtime] ${refusal}`);
    return {
      success: false,
      text: refusal,
      values: { error: "RESTART_GATE_CLOSED" },
      data: {
        actionName: "RUNTIME",
        op: "restart",
        reason,
        source,
        refused: "self-edit-not-enabled",
      },
    };
  }

  // Explicit owner chat requests retain the legacy RESTART_AGENT memory. A
  // branded internal request never inherits authority from ambient chat text.
  const persistChatRestart = isFromChat && !trustedRequest;
  const restartText = reason ? `Restarting… (${reason})` : "Restarting…";

  if (persistChatRestart && message) {
    logger.info(`[runtime] ${restartText}`);
    const restartMemory: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: { text: restartText, source: "eliza", type: "system" },
    };
    await runtime.createMemory(restartMemory, "messages");
  }

  setTimeout(() => {
    requestRestart(reason);
  }, SHUTDOWN_DELAY_MS);

  return {
    success: true,
    text: persistChatRestart
      ? restartText
      : reason
        ? `Runtime restart scheduled (${reason}).`
        : "Runtime restart scheduled.",
    values: { restarting: true },
    data: {
      actionName: "RUNTIME",
      op: "restart",
      reason,
      source,
      fromChat: persistChatRestart,
    },
  };
}

export const runtimeAction: Action = {
  name: "RUNTIME",
  contexts: [
    "admin",
    "agent_internal",
    "settings",
    "general",
    "connectors",
    "wallet",
  ],
  roleGate: { minRole: "OWNER" },
  similes: [
    // Old leaf action names
    "GET_RUNTIME_STATUS",
    "LIST_ACTIONS",
    "DESCRIBE_REGISTERED_ACTIONS",
    "RELOAD_RUNTIME_CONFIG",
    "RESTART_RUNTIME",
    "RESTART_AGENT",
    "GET_SELF_STATUS",
    // Common aliases
    "RUNTIME_STATUS",
    "AGENT_STATUS_RUNTIME",
    "RUNTIME_SNAPSHOT",
    "REGISTERED_ACTIONS",
    "AVAILABLE_ACTIONS",
    "RELOAD_CONFIG",
    "REFRESH_CONFIG",
    "RESTART_PROCESS",
    "RELOAD_RUNTIME",
    "BOUNCE_RUNTIME",
    "RESTART",
    "REBOOT",
    "RELOAD",
    "REFRESH",
    "RESPAWN",
    "RESTART_SELF",
    "REBOOT_AGENT",
    "RELOAD_AGENT",
    "CHECK_STATUS",
    "SELF_STATUS",
    "MY_STATUS",
    "SYSTEM_STATUS",
    "CHECK_SELF",
  ],
  description:
    "Polymorphic runtime control. action=status snapshots registered actions/providers/services; action=self_status returns Layer-2 awareness detail for a module (runtime, permissions, wallet, provider, pluginHealth, connectors, cloud, features); action=describe_actions lists registered actions, optionally filtered; action=reload_config re-applies hot-reloadable fields from eliza.json; action=restart bounces the process via the registered RestartHandler.",
  descriptionCompressed:
    "polymorphic runtime control: status, self_status, describe_actions, reload_config, restart",
  validate: async () => true,
  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    const handlerOptions = options as RuntimeHandlerOptions | undefined;
    const params =
      (handlerOptions?.parameters as RuntimeParams | undefined) ?? {};
    const trustedRestart = readTrustedRuntimeRestartRequest(
      handlerOptions?.trustedRestart,
    );
    const opRaw =
      typeof params.action === "string"
        ? params.action
        : typeof params.subaction === "string"
          ? params.subaction
          : typeof params.op === "string"
            ? params.op
            : "";
    const op = normalizeOp(opRaw);
    if (!op) {
      return {
        success: false,
        text: `Unknown op "${opRaw}". Valid: ${RUNTIME_OPS.join(", ")}.`,
        values: { error: "RUNTIME_INVALID", op: opRaw },
        data: {
          actionName: "RUNTIME",
          action: opRaw,
          error: "RUNTIME_INVALID",
        },
      };
    }
    switch (op) {
      case "status":
        return statusOp(runtime, params);
      case "self_status":
        return selfStatusOp(runtime, params);
      case "describe_actions":
        return describeActionsOp(runtime, params);
      case "reload_config":
        return reloadConfigOp();
      case "restart":
        return restartOp(runtime, message, params, trustedRestart);
    }
  },
  parameters: [
    {
      name: "action",
      description: `Runtime operation: ${RUNTIME_OPS.join(" | ")}.`,
      required: true,
      schema: {
        type: "string" as const,
        enum: [...RUNTIME_OPS, ...Object.keys(OP_ALIASES)],
      },
    },
    {
      name: "view",
      description: "status only: 'summary' (default) or 'counts'.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["summary", "counts"],
        default: "summary",
      },
    },
    {
      name: "module",
      description:
        "self_status only: which module to inspect (all, runtime, permissions, wallet, provider, pluginHealth, connectors, cloud, features). Default: all.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...SELF_STATUS_MODULES],
      },
    },
    {
      name: "detailLevel",
      description:
        "self_status only: 'brief' (~200 tokens, default) or 'full' (~2000 tokens).",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["brief", "full"],
      },
    },
    {
      name: "filter",
      description:
        "describe_actions only: case-insensitive substring filter on action names.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "restart only: optional reason for diagnostics.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "source",
      description:
        "restart only: legacy diagnostic hint. This planner-controlled field never authorizes a restart; user intent or a trusted internal request is required.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...RESTART_SOURCES],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What's the runtime status?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Agent: …", action: "RUNTIME" },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "How are your plugins doing right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin health: 12 loaded, 2 degraded.",
          action: "RUNTIME",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "List the actions you have registered." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Registered N action(s)…", action: "RUNTIME" },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Reload your config from disk." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Applied: …", action: "RUNTIME" },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "/restart" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Restarting…", action: "RUNTIME" },
      },
    ],
  ],
};
