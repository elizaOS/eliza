/**
 * Runtime introspection actions — surface the live agent runtime to callers.
 *
 * GET_RUNTIME_STATUS         → GET /api/runtime
 * DESCRIBE_REGISTERED_ACTIONS → reads runtime.actions in-process
 * RELOAD_RUNTIME_CONFIG       → POST /api/config/reload
 * RESTART_RUNTIME             → POST /api/restart
 */

import type { Action, ActionResult, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

interface RuntimeMetaShape {
  agentName?: string;
  agentState?: string;
  pluginCount?: number;
  actionCount?: number;
  providerCount?: number;
  evaluatorCount?: number;
  serviceCount?: number;
  model?: string | null;
}

interface RuntimeSnapshotShape {
  runtimeAvailable: boolean;
  generatedAt: string;
  meta: RuntimeMetaShape;
}

interface RuntimeStatusParams {
  view?: "summary" | "counts";
}

export const getRuntimeStatusAction: Action = {
  name: "GET_RUNTIME_STATUS",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: ["RUNTIME_STATUS", "AGENT_STATUS_RUNTIME", "RUNTIME_SNAPSHOT"],
  description:
    "Fetch a high-level runtime snapshot from /api/runtime: agent state, model, plugin / action / provider / evaluator / service counts.",
  descriptionCompressed:
    "fetch high-level runtime snapshot / api/runtime: agent state, model, plugin / action / provider / evaluator / service count",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    try {
      const resp = await fetch(`${getApiBase()}/api/runtime`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to fetch runtime status: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as RuntimeSnapshotShape;
      const params = (options as HandlerOptions | undefined)?.parameters as
        | RuntimeStatusParams
        | undefined;
      const view = params?.view === "counts" ? "counts" : "summary";
      const meta = data.meta ?? {};
      const countLine = `Plugins: ${meta.pluginCount ?? 0}, Actions: ${meta.actionCount ?? 0}, Providers: ${meta.providerCount ?? 0}, Evaluators: ${meta.evaluatorCount ?? 0}, Services: ${meta.serviceCount ?? 0}`;
      const lines =
        view === "counts"
          ? [countLine]
          : [
              `Runtime: ${data.runtimeAvailable ? "available" : "offline"}`,
              `Agent: ${meta.agentName ?? "unknown"} (${meta.agentState ?? "?"})`,
              `Model: ${meta.model ?? "n/a"}`,
              countLine,
              `Generated: ${data.generatedAt}`,
            ];
      return {
        success: true,
        text: lines.join("\n"),
        values: {
          runtimeAvailable: data.runtimeAvailable,
          actionCount: meta.actionCount ?? 0,
        },
        data: { actionName: "GET_RUNTIME_STATUS", snapshot: data, view },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[get-runtime-status] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to fetch runtime status: ${msg}`,
      };
    }
  },
  parameters: [
    {
      name: "view",
      description: "Runtime status view to return.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["summary", "counts"],
        default: "summary",
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
        content: {
          text: "Runtime: available...",
          action: "GET_RUNTIME_STATUS",
        },
      },
    ],
  ],
};

interface DescribeActionsParams {
  filter?: string;
}

export const describeRegisteredActionsAction: Action = {
  name: "DESCRIBE_REGISTERED_ACTIONS",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: ["LIST_ACTIONS", "REGISTERED_ACTIONS", "AVAILABLE_ACTIONS"],
  description:
    "List all actions currently registered on the runtime, with descriptions. Optionally filter by name substring (case-insensitive).",
  descriptionCompressed:
    "list action register runtime, w/ description optionally filter name substr (case-insensitive)",
  validate: async () => true,
  handler: async (
    runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | DescribeActionsParams
      | undefined;
    const filterRaw = params?.filter?.trim() ?? "";
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
        actionName: "DESCRIBE_REGISTERED_ACTIONS",
        filter: filterRaw,
        actions: matched.map((action) => ({
          name: action.name,
          description: action.description ?? "",
          similes: action.similes ?? [],
        })),
      },
    };
  },
  parameters: [
    {
      name: "filter",
      description:
        "Optional case-insensitive substring filter applied to action names.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "List the actions you have registered." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Registered N action(s)...",
          action: "DESCRIBE_REGISTERED_ACTIONS",
        },
      },
    ],
  ],
};

interface ReloadConfigResponse {
  reloaded?: boolean;
  applied?: string[];
  requiresRestart?: string[];
}

export const reloadRuntimeConfigAction: Action = {
  name: "RELOAD_RUNTIME_CONFIG",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: ["RELOAD_CONFIG", "REFRESH_CONFIG"],
  description:
    "Reload eliza.json from disk and apply hot-reloadable fields (character name/system/bio, voice config, provider API keys, feature flags) to the running runtime. Plugin list, model registry, and database changes still require RESTART_RUNTIME.",
  descriptionCompressed:
    "reload eliza json disk apply hot-reloadable field (character name/system/bio, voice config, provider API key, feature flag) run runtime plugin list, model registry, database change still require RESTART_RUNTIME",
  validate: async () => true,
  handler: async (_runtime, _message): Promise<ActionResult> => {
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
          // Body wasn't JSON — fall back to status text.
        }
        return {
          success: false,
          text: `Config reload failed: ${detail}`,
          values: { error: "RELOAD_FAILED" },
          data: { actionName: "RELOAD_RUNTIME_CONFIG" },
        };
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
          `Restart required for: ${requiresRestart.join(", ")} (run RESTART_RUNTIME).`,
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
        data: { actionName: "RELOAD_RUNTIME_CONFIG", response: data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[reload-runtime-config] failed: ${msg}`);
      return {
        success: false,
        text: `Config reload failed: ${msg}`,
      };
    }
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Reload your config from disk." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Applied: agents, ui...",
          action: "RELOAD_RUNTIME_CONFIG",
        },
      },
    ],
  ],
};

export const restartRuntimeAction: Action = {
  name: "RESTART_RUNTIME",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: ["RESTART_PROCESS", "RELOAD_RUNTIME", "BOUNCE_RUNTIME"],
  description:
    "Restart the agent runtime by hitting POST /api/restart. The process exits and the supervisor relaunches it.",
  descriptionCompressed:
    "restart agent runtime hit POST / api/restart process exit supervisor relaunch",
  validate: async () => true,
  handler: async (_runtime, _message): Promise<ActionResult> => {
    try {
      const resp = await fetch(`${getApiBase()}/api/restart`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          text: `Restart request failed: HTTP ${resp.status}`,
        };
      }
      return {
        success: true,
        text: "Runtime restart requested. The process will exit shortly and the supervisor will relaunch it.",
        values: { restarting: true },
        data: { actionName: "RESTART_RUNTIME" },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[restart-runtime] failed: ${msg}`);
      return {
        success: false,
        text: `Restart request failed: ${msg}`,
      };
    }
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Restart the runtime please." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Runtime restart requested...",
          action: "RESTART_RUNTIME",
        },
      },
    ],
  ],
};
