/**
 * LAUNCH_APP / STOP_APP / ATTACH_APP_RUN / LIST_APPS / GET_RUNNING_APPS /
 * FAVORITE_APP / SEND_APP_MESSAGE actions — let the agent control overlay apps.
 *
 * When LAUNCH_APP is triggered:
 *   1. Calls POST /api/apps/launch with the app name
 *   2. Returns a link to the app view
 *
 * When STOP_APP is triggered:
 *   1. Calls POST /api/apps/stop with the app name
 *   2. Returns confirmation
 *
 * @module actions/app-control
 */

import type { Action, ActionExample, Memory } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared/runtime-env";
import {
  getValidationKeywordTerms,
  normalizeKeywordMatchText,
  textIncludesKeywordTerm,
} from "@elizaos/shared/validation-keywords";
import { hasOwnerAccess } from "../security/access.js";

const LAUNCH_APP_TERMS = getValidationKeywordTerms(
  "action.appControl.launchVerb",
  {
    includeAllLocales: true,
  },
);
const STOP_APP_TERMS = getValidationKeywordTerms("action.appControl.stopVerb", {
  includeAllLocales: true,
});
const GENERIC_APP_TARGET_TERMS = getValidationKeywordTerms(
  "action.appControl.genericTarget",
  {
    includeAllLocales: true,
  },
);
const KNOWN_APP_TERMS = getValidationKeywordTerms(
  "action.appControl.knownApp",
  {
    includeAllLocales: true,
  },
);
const ALL_APP_TARGET_TERMS = [...GENERIC_APP_TARGET_TERMS, ...KNOWN_APP_TERMS];

function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeywordTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => textIncludesKeywordTerm(text, term));
}

function extractTargetAfterTerms(
  text: string,
  terms: readonly string[],
): string | null {
  const sortedTerms = [...terms].sort(
    (left, right) => right.length - left.length,
  );
  for (const term of sortedTerms) {
    const pattern = new RegExp(
      `${escapePattern(term).replace(/\\ /g, "\\s*")}\\s*([\\p{L}\\p{N}_-]+)`,
      "iu",
    );
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) {
      continue;
    }

    const normalizedCandidate = normalizeKeywordMatchText(candidate);
    if (
      GENERIC_APP_TARGET_TERMS.some(
        (target) => normalizeKeywordMatchText(target) === normalizedCandidate,
      )
    ) {
      return null;
    }

    return candidate.toLowerCase();
  }

  return null;
}

function extractAppName(message: Memory | undefined): string | null {
  const text = (message?.content?.text ?? "").trim();
  return (
    extractTargetAfterTerms(text, LAUNCH_APP_TERMS) ??
    extractTargetAfterTerms(text, STOP_APP_TERMS)
  );
}

function isLaunchRequest(message: Memory | undefined): boolean {
  const text = (message?.content?.text ?? "").trim();
  return (
    containsKeywordTerm(text, LAUNCH_APP_TERMS) &&
    containsKeywordTerm(text, ALL_APP_TARGET_TERMS)
  );
}

function isStopRequest(message: Memory | undefined): boolean {
  const text = (message?.content?.text ?? "").trim();
  return (
    containsKeywordTerm(text, STOP_APP_TERMS) &&
    containsKeywordTerm(text, ALL_APP_TARGET_TERMS)
  );
}

export const launchAppAction: Action = {
  name: "LAUNCH_APP",

  similes: [
    "OPEN_APP",
    "START_APP",
    "RUN_APP",
    "SHOW_APP",
    "LAUNCH_APPLICATION",
  ],

  description:
    "Launch an overlay app (e.g. Shopify, Vincent, Companion). " +
    "Returns a link to open the app in the dashboard.",

  validate: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) return false;
    return isLaunchRequest(message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may launch apps.",
      };
    }

    const params = options?.parameters as { name?: string } | undefined;
    const appName = params?.name?.trim() || extractAppName(message);

    if (!appName) {
      return {
        success: false,
        text: 'I need the app name to launch. Try: "launch shopify" or "open vincent"',
      };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(`${base}/api/apps/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: appName }),
        signal: AbortSignal.timeout(30_000),
      });

      const data = (await resp.json()) as {
        success?: boolean;
        displayName?: string;
        launchUrl?: string | null;
        run?: { runId?: string } | null;
        message?: string;
      };

      if (!resp.ok || data.success === false) {
        const errMsg =
          data.message || `Failed to launch ${appName} (${resp.status})`;
        logger.warn(`[app-control] launch failed: ${errMsg}`);
        return { success: false, text: errMsg };
      }

      const displayName = data.displayName || appName;
      const uiPort = process.env.ELIZA_PORT || "2138";
      const appLink = `http://localhost:${uiPort}/#/apps/${appName}`;

      logger.info(`[app-control] launched ${displayName}`);

      return {
        success: true,
        text: `${displayName} is now running. Open it here: ${appLink}`,
        values: { appName, displayName, appLink },
        data: { run: data.run },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[app-control] launch error: ${msg}`);
      return { success: false, text: `Failed to launch ${appName}: ${msg}` };
    }
  },

  parameters: [
    {
      name: "name",
      description:
        "The app name or slug to launch (e.g. 'shopify', 'vincent', 'companion').",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Fire up the Shopify app.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Shopify is now running. Open it here: http://localhost:2138/#/apps/shopify",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Open the companion overlay on my screen.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Companion is now running. Open it here: http://localhost:2138/#/apps/companion",
        },
      },
    ],
  ] as ActionExample[][],
};

export const stopAppAction: Action = {
  name: "STOP_APP",

  similes: [
    "CLOSE_APP",
    "SHUTDOWN_APP",
    "KILL_APP",
    "QUIT_APP",
    "EXIT_APP",
    "STOP_APPLICATION",
  ],

  description:
    "Stop a running overlay app by name. Uninstalls the plugin and tears " +
    "down the viewer session.",

  validate: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) return false;
    return isStopRequest(message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may stop apps.",
      };
    }

    const params = options?.parameters as { name?: string } | undefined;
    const appName = params?.name?.trim() || extractAppName(message);

    if (!appName) {
      return {
        success: false,
        text: 'I need the app name to stop. Try: "stop shopify" or "close vincent"',
      };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(`${base}/api/apps/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: appName }),
        signal: AbortSignal.timeout(15_000),
      });

      const data = (await resp.json()) as {
        success?: boolean;
        appName?: string;
        message?: string;
      };

      if (!resp.ok || data.success === false) {
        const errMsg =
          data.message || `Failed to stop ${appName} (${resp.status})`;
        logger.warn(`[app-control] stop failed: ${errMsg}`);
        return { success: false, text: errMsg };
      }

      const msg = data.message || `${appName} has been stopped.`;
      logger.info(`[app-control] stopped ${appName}`);

      return {
        success: true,
        text: msg,
        values: { appName },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[app-control] stop error: ${msg}`);
      return { success: false, text: `Failed to stop ${appName}: ${msg}` };
    }
  },

  parameters: [
    {
      name: "name",
      description:
        "The app name or slug to stop (e.g. 'shopify', 'vincent', 'companion').",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Shut down Shopify, I'm done with it for now.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "shopify has been stopped.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Close the companion overlay.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "companion has been stopped.",
        },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// ATTACH_APP_RUN — view a live running app run by re-attaching its viewer.
// ---------------------------------------------------------------------------

interface AppRunSummaryShape {
  runId: string;
  appName: string;
  displayName: string;
  status?: string;
  viewerAttachment?: string;
  viewer?: { url?: string | null } | null;
}

export const attachAppRunAction: Action = {
  name: "ATTACH_APP_RUN",

  similes: [
    "VIEW_APP_RUN",
    "OPEN_APP_RUN",
    "RESUME_APP_RUN",
    "ATTACH_RUN",
    "WATCH_APP_RUN",
  ],

  description:
    "Attach to a live running app run so its viewer is shown in the dashboard. " +
    "Use this when the user wants to see or resume an app that is already running.",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may attach app runs.",
      };
    }

    const params = options?.parameters as { runId?: string } | undefined;
    const runId = params?.runId?.trim();
    if (!runId) {
      return {
        success: false,
        text: "I need a runId to attach to.",
      };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(
        `${base}/api/apps/runs/${encodeURIComponent(runId)}/attach`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15_000),
        },
      );

      const data = (await resp.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        run?: AppRunSummaryShape | null;
      };

      if (!resp.ok || data.success === false) {
        const errMsg =
          data.message || `Failed to attach run ${runId} (${resp.status})`;
        logger.warn(`[app-control] attach failed: ${errMsg}`);
        return { success: false, text: errMsg };
      }

      const run = data.run;
      const displayName = run?.displayName ?? runId;
      const uiPort = process.env.ELIZA_PORT || "2138";
      const appLink = run
        ? `http://localhost:${uiPort}/#/apps/${run.appName}`
        : `http://localhost:${uiPort}/#/apps`;

      logger.info(`[app-control] attached run ${runId}`);

      return {
        success: true,
        text: `Attached to ${displayName}. Open it here: ${appLink}`,
        values: { runId, appLink, displayName },
        data: { run },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[app-control] attach error: ${msg}`);
      return { success: false, text: `Failed to attach run ${runId}: ${msg}` };
    }
  },

  parameters: [
    {
      name: "runId",
      description: "The run ID of the app run to attach to.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me the running shopify app again.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Attached to Shopify. Open it here: http://localhost:2138/#/apps/shopify",
        },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// LIST_APPS — enumerate available apps from the catalog or installed list.
// ---------------------------------------------------------------------------

type AppListFilter = "catalog" | "installed" | "running";

interface RegistryAppInfoShape {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  installed?: boolean;
}

interface InstalledAppInfoShape {
  name: string;
  displayName?: string;
  version?: string;
}

function isAppListFilter(value: unknown): value is AppListFilter {
  return value === "catalog" || value === "installed" || value === "running";
}

export const listAppsAction: Action = {
  name: "LIST_APPS",

  similes: [
    "SHOW_APPS",
    "ENUMERATE_APPS",
    "WHICH_APPS",
    "AVAILABLE_APPS",
    "GET_APPS",
  ],

  description:
    "List apps that the user can launch. Filter by 'catalog' for the full " +
    "registry, 'installed' for locally installed apps, or 'running' for live " +
    "runs. Defaults to the catalog.",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may list apps.",
      };
    }

    const params = options?.parameters as { filter?: unknown } | undefined;
    const filter: AppListFilter = isAppListFilter(params?.filter)
      ? params.filter
      : "catalog";

    const base = getApiBase();

    try {
      if (filter === "running") {
        const resp = await fetch(`${base}/api/apps/runs`, {
          signal: AbortSignal.timeout(15_000),
        });
        const runs = (await resp
          .json()
          .catch(() => [])) as AppRunSummaryShape[];
        if (!resp.ok) {
          return {
            success: false,
            text: `Failed to list running apps (${resp.status}).`,
          };
        }
        if (!Array.isArray(runs) || runs.length === 0) {
          return {
            success: true,
            text: "No apps are currently running.",
            data: { filter, count: 0, runs: [] },
          };
        }
        const lines = runs.map(
          (run) =>
            `- ${run.displayName} [${run.appName}] (run ${run.runId.slice(0, 8)}, ${run.status ?? "unknown"})`,
        );
        return {
          success: true,
          text: [`Running apps (${runs.length}):`, ...lines].join("\n"),
          data: { filter, count: runs.length, runs },
        };
      }

      const path = filter === "installed" ? "/api/apps/installed" : "/api/apps";
      const resp = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const apps = (await resp.json().catch(() => [])) as Array<
        RegistryAppInfoShape | InstalledAppInfoShape
      >;
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to list apps (${resp.status}).`,
        };
      }
      if (!Array.isArray(apps) || apps.length === 0) {
        return {
          success: true,
          text:
            filter === "installed"
              ? "No apps are installed."
              : "No apps available in the catalog.",
          data: { filter, count: 0, apps: [] },
        };
      }
      const lines = apps.map((app) => {
        const display = app.displayName ?? app.name;
        return `- ${display} [${app.name}]`;
      });
      return {
        success: true,
        text: [
          `${filter === "installed" ? "Installed" : "Catalog"} apps (${apps.length}):`,
          ...lines,
        ].join("\n"),
        data: { filter, count: apps.length, apps },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[app-control] list apps error: ${msg}`);
      return { success: false, text: `Failed to list apps: ${msg}` };
    }
  },

  parameters: [
    {
      name: "filter",
      description:
        "Which apps to list: 'catalog' (default, all known apps), 'installed', or 'running'.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["catalog", "installed", "running"],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Which apps can I launch?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Catalog apps (3):\n- Shopify [shopify]\n- Vincent [vincent]\n- Companion [companion]",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What apps are installed locally?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Installed apps (1):\n- Companion [companion]",
        },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// GET_RUNNING_APPS — list the currently active app runs with health.
// ---------------------------------------------------------------------------

export const getRunningAppsAction: Action = {
  name: "GET_RUNNING_APPS",

  similes: [
    "LIST_RUNNING_APPS",
    "WHICH_APPS_ARE_RUNNING",
    "ACTIVE_APP_RUNS",
    "SHOW_LIVE_APPS",
    "APP_RUNS",
  ],

  description:
    "Return the set of app runs currently active on this agent, with their " +
    "run IDs, app names, status, and viewer attachment state.",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may view running apps.",
      };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(`${base}/api/apps/runs`, {
        signal: AbortSignal.timeout(15_000),
      });
      const runs = (await resp.json().catch(() => [])) as AppRunSummaryShape[];
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to list app runs (${resp.status}).`,
        };
      }
      if (!Array.isArray(runs) || runs.length === 0) {
        return {
          success: true,
          text: "No apps are currently running.",
          data: { count: 0, runs: [] },
        };
      }
      const lines = runs.map((run) => {
        const status = run.status ?? "unknown";
        const attachment = run.viewerAttachment ?? "detached";
        return `- ${run.displayName} [${run.appName}] runId=${run.runId.slice(0, 8)} status=${status} viewer=${attachment}`;
      });
      return {
        success: true,
        text: [`Active app runs (${runs.length}):`, ...lines].join("\n"),
        data: { count: runs.length, runs },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[app-control] get running apps error: ${msg}`);
      return {
        success: false,
        text: `Failed to list running apps: ${msg}`,
      };
    }
  },

  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What apps are running right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Active app runs (1):\n- Shopify [shopify] runId=abc12345 status=running viewer=attached",
        },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// FAVORITE_APP — pin or unpin an app from the favorites list.
//
// The current dashboard persists favorites in browser localStorage under
// `eliza:favorite-apps` (see packages/app-core/src/state/persistence.ts).
// There is no server-side endpoint that owns this list yet, so the action
// reports that explicitly rather than silently writing somewhere the UI
// won't read back.
// ---------------------------------------------------------------------------

export const favoriteAppAction: Action = {
  name: "FAVORITE_APP",

  similes: ["PIN_APP", "STAR_APP", "BOOKMARK_APP", "UNFAVORITE_APP"],

  description:
    "Pin or unpin an app in the dashboard favorites list. Requires a server " +
    "endpoint to persist the change — currently the dashboard owns this " +
    "state in browser localStorage only.",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may change favorites.",
      };
    }

    const params = options?.parameters as
      | { appName?: string; isFavorite?: boolean }
      | undefined;
    const appName = params?.appName?.trim();
    const isFavorite = params?.isFavorite;

    if (!appName) {
      return {
        success: false,
        text: "I need an app name to favorite or unfavorite.",
      };
    }
    if (typeof isFavorite !== "boolean") {
      return {
        success: false,
        text: "I need to know whether to favorite (true) or unfavorite (false).",
      };
    }

    return {
      success: false,
      text:
        `Cannot ${isFavorite ? "favorite" : "unfavorite"} ${appName}: ` +
        "the favorites list lives in browser localStorage only. " +
        "A server endpoint (e.g. POST /api/apps/favorites) must be added " +
        "before the agent can persist this change.",
      data: { appName, isFavorite, blocked: "missing-server-endpoint" },
    };
  },

  parameters: [
    {
      name: "appName",
      description: "The app name or slug to (un)favorite.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "isFavorite",
      description: "true to add to favorites, false to remove.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Pin shopify to my favorites." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Cannot favorite shopify: the favorites list lives in browser localStorage only.",
        },
      },
    ],
  ] as ActionExample[][],
};

// ---------------------------------------------------------------------------
// SEND_APP_MESSAGE — steer a running app run by sending a chat message.
// ---------------------------------------------------------------------------

export const sendAppMessageAction: Action = {
  name: "SEND_APP_MESSAGE",

  similes: [
    "STEER_APP_RUN",
    "MESSAGE_APP_RUN",
    "TELL_APP",
    "SEND_TO_APP",
    "POST_APP_MESSAGE",
  ],

  description:
    "Send a chat message to a running app run. Apps that accept user input " +
    "(e.g. coding agents, character apps) will receive the message via " +
    "POST /api/apps/runs/{runId}/message.",

  validate: async (runtime, message) => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may send app messages.",
      };
    }

    const params = options?.parameters as
      | { runId?: string; message?: string }
      | undefined;
    const runId = params?.runId?.trim();
    const content = params?.message?.trim();

    if (!runId) {
      return { success: false, text: "I need a runId to send a message to." };
    }
    if (!content) {
      return { success: false, text: "I need a message to send." };
    }

    try {
      const base = getApiBase();
      const resp = await fetch(
        `${base}/api/apps/runs/${encodeURIComponent(runId)}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const data = (await resp.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
      };
      if (!resp.ok || data.success === false) {
        const errMsg =
          data.message || `Failed to send message (${resp.status}).`;
        logger.warn(`[app-control] send message failed: ${errMsg}`);
        return { success: false, text: errMsg };
      }
      const replyMsg = data.message || `Message delivered to run ${runId}.`;
      logger.info(`[app-control] sent message to run ${runId}`);
      return {
        success: true,
        text: replyMsg,
        values: { runId },
        data: { runId, response: data },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[app-control] send message error: ${msg}`);
      return {
        success: false,
        text: `Failed to send message to run ${runId}: ${msg}`,
      };
    }
  },

  parameters: [
    {
      name: "runId",
      description: "The run ID of the target app run.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "message",
      description: "The message text to deliver to the app run.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Tell the steward run to start a new task: refactor the api module.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message delivered to run abc12345.",
        },
      },
    ],
  ] as ActionExample[][],
};
