/**
 * Gate hosted app plugins so actions/providers only apply while the app session
 * is active (AppManager run and/or overlay heartbeat for local overlay apps).
 */

import type {
  Action,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
} from "@elizaos/core";
import {
  APP_SESSION_SERVICE_TYPE,
  type AppSessionServiceLike,
} from "@elizaos/shared";
import { isOverlayAppPresenceActive } from "./overlay-app-presence.ts";

const STOPPED_STATUSES = new Set(["stopped", "offline", "error", "failed"]);

function isRunStatusActive(status: string): boolean {
  return !STOPPED_STATUSES.has(status.trim().toLowerCase());
}

/**
 * True when an AppManager run exists for this canonical app name and is not
 * stopped. Reads runs from the `@elizaos/plugin-app-manager` AppSessionService
 * registered on the runtime; if the service is absent (plugin not loaded) it
 * fails open to "no active runs" rather than importing the plugin statically.
 */
export function hasActiveAppRunForCanonicalName(
  runtime: IAgentRuntime,
  appCanonicalName: string,
): boolean {
  const service = runtime.getService<Service & AppSessionServiceLike>(
    APP_SESSION_SERVICE_TYPE,
  );
  if (!service) {
    return false;
  }
  return service
    .getRuns()
    .some(
      (run) =>
        run.appName === appCanonicalName && isRunStatusActive(run.status),
    );
}

/**
 * True when the app is usable for agent actions: either a live AppManager run
 * or a recent dashboard heartbeat for an overlay app (e.g. companion).
 */
export function isHostedAppActiveForAgentActions(
  runtime: IAgentRuntime,
  appCanonicalName: string,
): boolean {
  if (hasActiveAppRunForCanonicalName(runtime, appCanonicalName)) {
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
        if (!isHostedAppActiveForAgentActions(runtime, appCanonicalName)) {
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
        if (!isHostedAppActiveForAgentActions(runtime, appCanonicalName)) {
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
