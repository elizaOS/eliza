/**
 * LAUNCH_APP / STOP_APP actions — let the agent launch and stop overlay apps.
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

import type { Action, Memory } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getValidationKeywordTerms,
  normalizeKeywordMatchText,
  textIncludesKeywordTerm,
} from "@elizaos/shared/validation-keywords";
import { resolveServerOnlyPort } from "@elizaos/shared/runtime-env";
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
};
