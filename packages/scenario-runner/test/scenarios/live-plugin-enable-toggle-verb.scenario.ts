/**
 * Live-lane proof for issue #14368 AC4 (plugin enable/disable half): a real LLM,
 * asked to toggle a plugin, must route through the semantic `PLUGIN` toggle verb
 * — the same `PUT /api/plugins/:id` the Plugins view's per-card toggle calls —
 * rather than the generic synthetic-DOM bridge (`VIEWS agent-click`).
 *
 * The seed registers the owner `PLUGIN` action exactly as the real agent does
 * (`promoteSubactionsToActions`, so the planner sees the dedicated
 * `PLUGIN_TOGGLE` verb, not just the umbrella) and a fetch shim standing in for
 * the app-core `/api/plugins` + `/api/plugins/:id` routes, so the real
 * `doList`/`doToggle` handlers run end-to-end and the outbound toggle request is
 * captured. The runtime factory always loads plugin-personal-assistant, so the
 * `PLUGIN` verb competes against the full LifeOps action set (incl. the
 * account-level `CONNECTOR` verb) — the scenario proves the model still selects
 * plugin-package management. A first "open plugin settings and list my plugins"
 * turn anchors the PLUGIN verb in context (the way a user browsing the Plugins
 * view would before toggling one) so the disable turn commits to the tool; only
 * the disable outcome is asserted. No Plugins view is mounted, so `agent-click`
 * is structurally unavailable and the final check asserts no `VIEWS`/`agent-*`
 * capability was used.
 *
 * Reliability note: this is a live-only manual evidence asset (not a CI gate).
 * The scenario runtime uses a zero-vector embedding fallback (it never downloads
 * the gated on-device embedding model), so action retrieval cannot rank the ~80
 * always-loaded actions semantically; on a minority of boots the capped
 * per-context action list drops the `PLUGIN` verb from the model's tool context
 * for the whole conversation and every turn answers with a bare ack. The priming
 * turn plus re-asks make a "good" boot green; the deterministic wiring itself
 * (`PLUGIN toggle` -> `PUT /api/plugins/:id`) is covered keyless by
 * `packages/agent/src/actions/plugin-toggle.test.ts` (#14531). Needs live model
 * credentials (live-only lane).
 */
import { pluginAction } from "@elizaos/agent/actions/plugin";
import {
  type IAgentRuntime,
  type Plugin,
  promoteSubactionsToActions,
} from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

// A settings-tab priming ask before the toggle: the model reliably routes an
// installed-plugins list to the PLUGIN verb, which anchors the same tool in
// context (and returns the shim catalog showing discord enabled) so the disable
// turn commits to the semantic verb rather than a bare conversational ack.
const LIST_TEXT =
  "Open my plugin settings and list every installed plugin with its enabled/disabled state.";
// The disable ask is re-issued a few ways in the same primed conversation: a
// live model that answers a tool-satisfiable request with a bare ack on one
// turn commits to the PLUGIN verb on a re-ask, exactly as an owner would repeat
// themselves. The scenario asserts the toggle fires across the conversation, so
// one stray ack does not fail an otherwise-correct routing proof.
const DISABLE_ATTEMPTS = [
  "Now disable the discord plugin.",
  "Please actually switch the discord plugin off — toggle its enabled flag to false.",
  "Go ahead and turn the discord plugin off in my plugin settings.",
] as const;
const SCENARIO_PLUGIN_NAME = "scenario-plugin-toggle";

type ToggleRecord = { pluginId: string; enabled: boolean };

const state: { toggles: ToggleRecord[] } = { toggles: [] };
let restoreFetch: (() => void) | null = null;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionParams(action: CapturedAction): JsonRecord {
  const envelope = isRecord(action.parameters) ? action.parameters : {};
  return isRecord(envelope.parameters) ? envelope.parameters : envelope;
}

function isPluginFamily(name: string): boolean {
  return name === "PLUGIN" || name.startsWith("PLUGIN_");
}

/**
 * Stand in for the app-core plugin routes the `PLUGIN` handlers hit on a fixed
 * localhost port (app-core owns them in production; they are not mounted in the
 * bare scenario runtime): `GET /api/plugins` returns a small catalog with
 * discord enabled so the list turn is real, and `PUT /api/plugins/:id` records
 * the toggle so the domain effect is asserted.
 */
function installPluginFetchShim(): void {
  restoreFetch?.();
  const originalFetch = globalThis.fetch;
  const catalog = {
    plugins: [
      {
        id: "discord",
        name: "Discord",
        description: "Discord chat connector plugin.",
        enabled: true,
        configured: true,
        parameters: [],
        category: "connector",
      },
      {
        id: "telegram",
        name: "Telegram",
        description: "Telegram chat connector plugin.",
        enabled: false,
        configured: false,
        parameters: [],
        category: "connector",
      },
    ],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlText =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let url: URL | null = null;
    try {
      url = new URL(urlText);
    } catch {
      // error-policy:J3 non-absolute request target is not a plugins route; defer to real fetch.
      url = null;
    }
    const isLocal =
      url?.hostname === "localhost" || url?.hostname === "127.0.0.1";
    const method = (init?.method ?? "GET").toUpperCase();
    if (url && isLocal && url.pathname === "/api/plugins" && method === "GET") {
      return new Response(JSON.stringify(catalog), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }
    if (
      url &&
      isLocal &&
      url.pathname.startsWith("/api/plugins/") &&
      method === "PUT"
    ) {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as JsonRecord)
          : {};
      const pluginId = decodeURIComponent(
        url.pathname.slice("/api/plugins/".length),
      );
      if (typeof body.enabled === "boolean") {
        state.toggles.push({ pluginId, enabled: body.enabled });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
    restoreFetch = null;
  };
}

type RuntimeWithRegister = IAgentRuntime & {
  plugins?: Array<{ name?: string }>;
  registerPlugin?: (plugin: Plugin) => Promise<void>;
};

async function seedPluginActionAndShim(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  state.toggles.length = 0;
  installPluginFetchShim();

  const runtime = ctx.runtime as RuntimeWithRegister;
  if (!runtime.registerPlugin) {
    return "runtime.registerPlugin unavailable";
  }
  const scenarioPluginTogglePlugin: Plugin = {
    name: SCENARIO_PLUGIN_NAME,
    description:
      "Scenario-only registration of the owner PLUGIN action (and its promoted " +
      "PLUGIN_TOGGLE/PLUGIN_LIST virtuals) so the planner can select the " +
      "semantic plugin-management verbs under a bare scenario runtime.",
    actions: [...promoteSubactionsToActions(pluginAction)],
  };
  if (!runtime.plugins?.some((p) => p.name === SCENARIO_PLUGIN_NAME)) {
    await runtime.registerPlugin(scenarioPluginTogglePlugin);
  }
  return undefined;
}

function noSyntheticDomFallback(ctx: ScenarioContext): string | undefined {
  for (const call of ctx.actionsCalled) {
    if (call.actionName === "VIEWS") {
      return `expected no VIEWS synthetic-DOM fallback, saw VIEWS with ${JSON.stringify(actionParams(call))}`;
    }
    const capability = actionParams(call).capability;
    if (capability === "agent-fill" || capability === "agent-click") {
      return `expected no agent-fill/agent-click, saw capability=${String(capability)}`;
    }
  }
  return undefined;
}

function pluginToggleSucceeded(ctx: ScenarioContext): string | undefined {
  const toggled = ctx.actionsCalled.some((call) => {
    if (!isPluginFamily(call.actionName)) return false;
    const params = actionParams(call);
    const op = params.action ?? params.subaction ?? params.op;
    return (
      op === "toggle" &&
      params.enabled === false &&
      call.result?.success === true
    );
  });
  if (!toggled) {
    const seen =
      ctx.actionsCalled.map((c) => c.actionName).join(", ") || "none";
    return `expected a successful PLUGIN-family toggle enabled=false, saw ${seen}`;
  }
  return state.toggles.some(
    (t) => t.enabled === false && t.pluginId.toLowerCase().includes("discord"),
  )
    ? undefined
    : `expected the discord disable to reach PUT /api/plugins/:id, saw ${JSON.stringify(state.toggles)}`;
}

export default scenario({
  id: "live-plugin-enable-toggle-verb",
  lane: "live-only",
  title: "Live plugin toggle routes to PLUGIN verb, not agent-click",
  domain: "app-control",
  tags: ["live", "app-control", "plugins", "views", "plugin-toggle"],
  isolation: "shared-runtime",
  requires: {
    plugins: [SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register PLUGIN verbs + /api/plugins fetch shim",
      apply: seedPluginActionAndShim,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore plugin fetch shim",
      apply: () => {
        restoreFetch?.();
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Live Plugin Toggle",
    },
  ],
  turns: [
    {
      // Priming turn: a user opening plugin settings before toggling one. Anchors
      // the PLUGIN verb (and the shim catalog) in context so the disable turn
      // commits to the tool. Asserted loosely — context, not the claim under test.
      kind: "message",
      name: "owner opens plugin settings and lists plugins",
      text: LIST_TEXT,
      responseIncludesAny: [
        "discord",
        "Discord",
        "plugin",
        "enabled",
        "Telegram",
      ],
    },
    ...DISABLE_ATTEMPTS.map((text, index) => ({
      kind: "message" as const,
      name: `owner disables the discord plugin (ask ${index + 1})`,
      text,
    })),
  ],
  finalChecks: [
    {
      type: "custom",
      name: "PLUGIN-family toggle disabled discord via PUT /api/plugins/:id",
      predicate: pluginToggleSucceeded,
    },
    {
      type: "custom",
      name: "no synthetic-DOM (VIEWS/agent-click) fallback was used",
      predicate: noSyntheticDomFallback,
    },
  ],
});
