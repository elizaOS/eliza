/**
 * Gate hosted app plugins so actions/providers only apply while the app session
 * is active (AppManager run and/or overlay heartbeat for local overlay apps).
 */

import * as fs from "node:fs";
import path from "node:path";
import type { Action, Plugin, Provider } from "@elizaos/core";
import { resolveStateDir } from "../config/paths.ts";
import { isOverlayAppPresenceActive } from "./overlay-app-presence.ts";

const STOPPED_STATUSES = new Set(["stopped", "offline", "error", "failed"]);

type AppRunActivitySnapshot = {
  appName: string;
  status: string;
};

function readAppRunActivitySnapshots(): AppRunActivitySnapshot[] {
  const stateDir = resolveStateDir();
  const candidates = [
    path.join(stateDir, "apps", "runs.v2.json"),
    path.join(stateDir, "apps", "runs.v1.json"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        runs?: unknown;
      };
      if (!Array.isArray(parsed.runs)) continue;
      return parsed.runs
        .map((run): AppRunActivitySnapshot | null => {
          if (!run || typeof run !== "object") return null;
          const record = run as Record<string, unknown>;
          if (
            typeof record.appName !== "string" ||
            typeof record.status !== "string"
          ) {
            return null;
          }
          return { appName: record.appName, status: record.status };
        })
        .filter((run): run is AppRunActivitySnapshot => run !== null);
    } catch {
      const corruptPath = `${filePath}.corrupt-${Date.now()}.json`;
      try {
        fs.renameSync(filePath, corruptPath);
      } catch {
        // If the corrupt file cannot be moved, treat it as no active runs.
      }
      return [];
    }
  }

  return [];
}

function isRunStatusActive(status: string): boolean {
  return !STOPPED_STATUSES.has(status.trim().toLowerCase());
}

/** True when an AppManager run exists for this canonical app name and is not stopped. */
export function hasActiveAppRunForCanonicalName(
  appCanonicalName: string,
): boolean {
  const runs = readAppRunActivitySnapshots();
  return runs.some(
    (run) => run.appName === appCanonicalName && isRunStatusActive(run.status),
  );
}

/**
 * True when the app is usable for agent actions: either a live AppManager run
 * or a recent dashboard heartbeat for an overlay app (e.g. companion).
 */
export function isHostedAppActiveForAgentActions(
  appCanonicalName: string,
): boolean {
  if (hasActiveAppRunForCanonicalName(appCanonicalName)) {
    return true;
  }
  return isOverlayAppPresenceActive(appCanonicalName);
}

function gateActions(
  actions: Action[] | undefined,
  appCanonicalName: string,
): Action[] | undefined {
  if (!actions?.length) return actions;
  return actions.map((action) => {
    const prevValidate = action.validate;
    return {
      ...action,
      validate: async (runtime, message, state) => {
        if (!isHostedAppActiveForAgentActions(appCanonicalName)) {
          return false;
        }
        if (prevValidate) {
          return prevValidate(runtime, message, state);
        }
        return true;
      },
    };
  });
}

function gateProviders(
  providers: Provider[] | undefined,
  appCanonicalName: string,
): Provider[] | undefined {
  if (!providers?.length) return providers;
  return providers.map((provider) => {
    const prevGet = provider.get;
    return {
      ...provider,
      get: async (runtime, message, state) => {
        if (!isHostedAppActiveForAgentActions(appCanonicalName)) {
          return {
            text: "",
            data: { available: false, appSessionInactive: true },
          };
        }
        return prevGet(runtime, message, state);
      },
    };
  });
}

/** Wrap a plugin so every action validate and provider get requires an active app session. */
export function gatePluginSessionForHostedApp(
  plugin: Plugin,
  appCanonicalName: string,
): Plugin {
  return {
    ...plugin,
    actions: gateActions(plugin.actions, appCanonicalName),
    providers: gateProviders(plugin.providers, appCanonicalName),
  };
}
