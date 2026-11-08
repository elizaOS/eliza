/** Runtime control and complete in-process introspection. */
import crypto from "node:crypto";
import {
  type Action,
  type ActionResult,
  getValidationKeywordTerms,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  textIncludesKeywordTerm,
  toWellFormedUnicode,
  type UUID,
} from "@elizaos/core";
import { isSelfEditEnabled } from "@elizaos/host";
import {
  createSelfApiRequestHeaders,
  requireRestartHandler,
  resolveSelfApiBaseUrl,
} from "@elizaos/host/protocol";

const RUNTIME_OPS = [
  "status",
  "self_status",
  "describe_actions",
  "reload_config",
  "restart",
] as const;

type RuntimeOp = (typeof RUNTIME_OPS)[number];

const RESTART_SOURCES = ["self-edit", "user", "plugin-install"] as const;
type RestartSource = (typeof RESTART_SOURCES)[number];

interface RuntimeParams {
  action?: string;
  view?: "summary" | "counts";
  filter?: string;
  reason?: string;
  source?: RestartSource;
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
  return null;
}

function isRestartSource(value: string | undefined): value is RestartSource {
  return (
    typeof value === "string" &&
    (RESTART_SOURCES as readonly string[]).includes(value)
  );
}

function getApiBase(): string {
  return resolveSelfApiBaseUrl(process.env);
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
  reloaded: true;
  applied: string[];
  requiresRestart: string[];
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** The reload route answers `{ reloaded: true, applied, requiresRestart }`; anything else is not an acknowledgement. */
function isReloadConfigAcknowledgement(
  value: unknown,
): value is ReloadConfigResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.reloaded === true &&
    isStringArray(record.applied) &&
    isStringArray(record.requiresRestart)
  );
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
    const data: unknown = await resp.json();
    if (!isReloadConfigAcknowledgement(data)) {
      // A 2xx without the route's acknowledgement proves no reload happened;
      // reporting "No hot-reloadable fields changed." would claim one did.
      logger.warn(
        `[runtime] reload_config response did not acknowledge the reload (${resp.status}).`,
      );
      return fail(
        "reload_config",
        `Config reload failed: the server did not acknowledge the reload (HTTP ${resp.status}).`,
      );
    }
    const { applied, requiresRestart } = data;
    const lines = [
      applied.length
        ? `Applied: ${applied.join(", ")}`
        : "No hot-reloadable fields changed.",
    ];
    if (requiresRestart.length) {
      lines.push(
        `Restart required for: ${requiresRestart.join(", ")} (run RUNTIME action=restart).`,
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
): Promise<ActionResult> {
  const reason =
    typeof params.reason === "string"
      ? toWellFormedUnicode(params.reason)
      : undefined;
  const source = isRestartSource(params.source) ? params.source : undefined;

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

  // When a chat message is present and was an explicit restart request, persist
  // a memory entry. When invoked without a
  // message context (programmatic) or via an internal source, skip the memory
  // write.
  const restart = requireRestartHandler();
  const isFromChat = isExplicitRestartRequest(message);
  const restartText = reason ? `Restarting… (${reason})` : "Restarting…";

  if (isFromChat && message) {
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
    void Promise.resolve()
      .then(() => restart(reason))
      .catch((error: unknown) => {
        // error-policy:J7 deferred host failures remain observable after action admission.
        logger.error({ error, reason }, "[runtime] Deferred restart failed");
        runtime.reportError("runtime.restart", error);
      });
  }, SHUTDOWN_DELAY_MS);

  return {
    success: true,
    text: isFromChat
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
      fromChat: isFromChat,
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
    "Polymorphic runtime control. action=status snapshots registered actions/providers/services; action=self_status returns the same live status snapshot; action=describe_actions lists registered actions, optionally filtered; action=reload_config re-applies hot-reloadable fields from eliza.json; action=restart bounces the process via the registered RestartHandler.",
  descriptionCompressed:
    "polymorphic runtime control: status, self_status, describe_actions, reload_config, restart",
  validate: async () => true,
  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | RuntimeParams
        | undefined) ?? {};
    const opRaw = typeof params.action === "string" ? params.action : "";
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
        return statusOp(runtime, params);
      case "describe_actions":
        return describeActionsOp(runtime, params);
      case "reload_config":
        return reloadConfigOp();
      case "restart":
        return restartOp(runtime, message, params);
    }
  },
  parameters: [
    {
      name: "action",
      description: `Runtime operation: ${RUNTIME_OPS.join(" | ")}.`,
      required: true,
      schema: {
        type: "string" as const,
        enum: [...RUNTIME_OPS],
      },
    },
    {
      name: "view",
      description: "status and self_status: 'summary' (default) or 'counts'.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["summary", "counts"],
        default: "summary",
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
        "restart only: 'self-edit' (gated by isSelfEditEnabled), 'user', or 'plugin-install'.",
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
        content: { text: "How are you doing right now?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Agent: …", action: "RUNTIME" },
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
