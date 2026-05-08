/**
 * RUNTIME action — single polymorphic entry point for runtime ops.
 *
 * Ops:
 *   - status         in-process snapshot of agent + counts
 *   - list_actions   in-process listing of registered actions, optionally filtered
 *   - reload_config  POST /api/config/reload (loadElizaConfig + applyReloadedConfig
 *                    are not exported; the HTTP route owns the state.config + diff)
 *   - restart        in-process: requestRestart() via the registered RestartHandler
 *   - restart_agent  user-validated restart that persists a memory entry first;
 *                    semantics differ from `restart` and remain a distinct op
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
import { logger } from "@elizaos/core";
import {
  getValidationKeywordTerms,
  isSelfEditEnabled,
  resolveServerOnlyPort,
  textIncludesKeywordTerm,
} from "@elizaos/shared";
import { requestRestart } from "../runtime/restart.js";

const RUNTIME_OPS = [
  "status",
  "list_actions",
  "reload_config",
  "restart",
  "restart_agent",
] as const;

type RuntimeOp = (typeof RUNTIME_OPS)[number];

const RESTART_SOURCES = ["self-edit", "user", "plugin-install"] as const;
type RestartSource = (typeof RESTART_SOURCES)[number];

interface RuntimeParams {
  op?: string;
  view?: "summary" | "counts";
  filter?: string;
  reason?: string;
  source?: RestartSource;
}

/** Small delay (ms) before restarting so the response has time to flush. */
const SHUTDOWN_DELAY_MS = 1_500;
const MAX_RESTART_REASON_CHARS = 240;

const RESTART_REQUEST_TERMS = getValidationKeywordTerms(
  "action.restart.request",
  { includeAllLocales: true },
);

function isRuntimeOp(value: string): value is RuntimeOp {
  return (RUNTIME_OPS as readonly string[]).includes(value);
}

function isRestartSource(value: string | undefined): value is RestartSource {
  return (
    typeof value === "string" &&
    (RESTART_SOURCES as readonly string[]).includes(value)
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
  const actionCount = runtime.actions?.length ?? 0;
  const providerCount = runtime.providers?.length ?? 0;
  const evaluatorCount = runtime.evaluators?.length ?? 0;
  const services = runtime.services as Map<string, unknown[]> | undefined;
  let serviceCount = 0;
  if (services) {
    for (const list of services.values()) {
      serviceCount += list.length;
    }
  }
  const character = runtime.character;
  const agentName = character?.name ?? "unknown";
  const model =
    (character?.settings?.MODEL_PROVIDER as string | undefined) ??
    (character?.settings?.model as string | undefined) ??
    null;
  const generatedAt = new Date().toISOString();
  const countLine = `Actions: ${actionCount}, Providers: ${providerCount}, Evaluators: ${evaluatorCount}, Services: ${serviceCount}`;
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
    values: { actionCount, providerCount, evaluatorCount, serviceCount },
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
        evaluatorCount,
        serviceCount,
        generatedAt,
      },
    },
  };
}

function listActionsOp(
  runtime: IAgentRuntime,
  params: RuntimeParams,
): ActionResult {
  const filterRaw = params.filter?.trim() ?? "";
  const filter = filterRaw.toLowerCase();
  const all = runtime.actions ?? [];
  const matched = filter
    ? all.filter((action) => action.name.toLowerCase().includes(filter))
    : [...all];
  matched.sort((a, b) => a.name.localeCompare(b.name));
  const lines = matched.map((action) => {
    const description = action.description?.trim() ?? "";
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
      op: "list_actions",
      filter: filterRaw,
      actions: matched.map((action) => ({
        name: action.name,
        description: action.description ?? "",
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
  // The route handler owns ConfigRouteContext (state.config, BLOCKED_ENV_KEYS)
  // and the diff/apply helpers are file-private. Until those are extracted to
  // a service, this op stays HTTP-backed.
  try {
    const resp = await fetch(`${getApiBase()}/api/config/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

async function restartOp(params: RuntimeParams): Promise<ActionResult> {
  const reason =
    typeof params.reason === "string"
      ? params.reason.slice(0, MAX_RESTART_REASON_CHARS)
      : undefined;
  try {
    setTimeout(() => {
      requestRestart(reason);
    }, SHUTDOWN_DELAY_MS);
    return {
      success: true,
      text: reason
        ? `Runtime restart scheduled (${reason}).`
        : "Runtime restart scheduled.",
      values: { restarting: true },
      data: { actionName: "RUNTIME", op: "restart", reason },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[runtime] restart failed: ${msg}`);
    return fail("restart", `Restart request failed: ${msg}`);
  }
}

async function restartAgentOp(
  runtime: IAgentRuntime,
  message: Memory | undefined,
  params: RuntimeParams,
): Promise<ActionResult> {
  // Guard: only restart when the user explicitly asked. The runtime doesn't
  // call validate before handler, and the LLM can fuzzy-match restart_agent
  // from action loops or stray text fragments.
  if (!isExplicitRestartRequest(message)) {
    return fail("restart_agent", "Refused: no explicit user restart request.");
  }

  const reason =
    typeof params.reason === "string"
      ? params.reason.slice(0, MAX_RESTART_REASON_CHARS)
      : undefined;
  const source = isRestartSource(params.source) ? params.source : undefined;

  // Self-edit-driven restarts must only execute when the dev-mode gate is
  // open. Other restart sources (user-issued, plugin install) bypass the gate.
  if (source === "self-edit" && !isSelfEditEnabled()) {
    const refusal =
      "Refused: self-edit restart requires dev mode " +
      "(MILADY_ENABLE_SELF_EDIT=1 plus NODE_ENV!=production or MILADY_DEV_MODE=1).";
    logger.warn(`[runtime] ${refusal}`);
    return {
      success: false,
      text: refusal,
      values: { error: "RESTART_AGENT_GATE_CLOSED" },
      data: {
        actionName: "RUNTIME",
        op: "restart_agent",
        reason,
        source,
        refused: "self-edit-not-enabled",
      },
    };
  }

  if (!message) {
    return fail("restart_agent", "Refused: missing trigger message context.");
  }

  const restartText = reason ? `Restarting… (${reason})` : "Restarting…";
  logger.info(`[runtime] ${restartText}`);

  const restartMemory: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    roomId: message.roomId,
    worldId: message.worldId,
    content: { text: restartText, source: "eliza", type: "system" },
  };
  await runtime.createMemory(restartMemory, "messages");

  setTimeout(() => {
    requestRestart(reason);
  }, SHUTDOWN_DELAY_MS);

  return {
    success: true,
    text: restartText,
    values: { restarting: true },
    data: { actionName: "RUNTIME", op: "restart_agent", reason, source },
  };
}

export const runtimeAction: Action = {
  name: "RUNTIME",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: [],
  description:
    "Polymorphic runtime control: status (snapshot of registered actions/providers/evaluators/services), list_actions (registered actions, optionally filtered), reload_config (re-apply hot-reloadable fields from eliza.json), restart (bounce process via supervisor), restart_agent (user-requested restart with memory entry).",
  descriptionCompressed:
    "polymorphic runtime control: status, list_actions, reload_config, restart, restart_agent",
  validate: async () => true,
  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | RuntimeParams
        | undefined) ?? {};
    const opRaw = typeof params.op === "string" ? params.op : "";
    if (!isRuntimeOp(opRaw)) {
      return {
        success: false,
        text: `Unknown op "${opRaw}". Valid: ${RUNTIME_OPS.join(", ")}.`,
        values: { error: "RUNTIME_INVALID_OP", op: opRaw },
        data: { actionName: "RUNTIME", op: opRaw, error: "RUNTIME_INVALID_OP" },
      };
    }
    switch (opRaw) {
      case "status":
        return statusOp(runtime, params);
      case "list_actions":
        return listActionsOp(runtime, params);
      case "reload_config":
        return reloadConfigOp();
      case "restart":
        return restartOp(params);
      case "restart_agent":
        return restartAgentOp(runtime, message, params);
    }
  },
  parameters: [
    {
      name: "op",
      description: `Runtime operation: ${RUNTIME_OPS.join(" | ")}.`,
      required: true,
      schema: {
        type: "string" as const,
        enum: [...RUNTIME_OPS],
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
      name: "filter",
      description:
        "list_actions only: case-insensitive substring filter on action names.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description:
        "restart / restart_agent only: optional reason for diagnostics.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "source",
      description:
        "restart_agent only: 'self-edit' (gated by isSelfEditEnabled), 'user', or 'plugin-install'.",
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
