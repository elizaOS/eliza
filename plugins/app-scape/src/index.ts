import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import type { Plugin, ServiceClass } from "@elizaos/core";

import { scapeActions } from "./actions/index.js";
import { scapeProviders } from "./providers/index.js";
import { ScapeGameService } from "./services/game-service.js";

/**
 * `@elizaos/app-scape` plugin entry point.
 *
 * PR 2 scope: plugin shell only. Declares the app metadata that the
 * eliza launcher reads (display name, capabilities, viewer URL) and
 * wires up the minimal route handler that serves the viewer iframe.
 *
 * PR 3+ will add `services`, `actions`, and `providers` so the LLM
 * runtime can drive an agent in the xRSPS world. Until then the plugin
 * is a pure launcher / viewer wrapper — clicking 'scape in the apps
 * view opens the xRSPS client in an iframe, and users can log in
 * themselves with a human account.
 */
export function createAppScapePlugin(): Plugin {
  return {
    name: "@elizaos/app-scape",
    description:
      "'scape — first-class agent integration for xRSPS. Autonomous RuneScape-alike agent with JSON-encoded state, a Scape Journal, and directed-prompt operator control.",
    // Service + routers + providers all register on plugin load.
    // The runtime boots ScapeGameService, discovers the compressed game
    // routers and JSON providers, and the game-service kicks off its autonomous
    // LLM loop as soon as the first perception snapshot arrives.
    services: [ScapeGameService as ServiceClass],
    actions: scapeActions,
    providers: scapeProviders,
    app: {
      displayName: "'scape",
      category: "game",
      launchType: "connect",
      launchUrl: resolveLaunchUrl(),
      capabilities: ["autonomous", "game", "journal", "operator-steering"],
      runtimePlugin: "@elizaos/app-scape",
      viewer: {
        url: "/api/apps/scape/viewer",
        sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
      },
      session: {
        mode: "spectate-and-steer",
        features: ["commands", "telemetry", "suggestions"],
      },
    },
  };
}

/**
 * The launcher's `launchUrl` is a hint for clients that don't use the
 * embedded viewer route. We read `SCAPE_CLIENT_URL` at module load so
 * operators can override it for a local dev xRSPS instance or a
 * fork's deployment. The default points at the live 'scape
 * deployment on Sevalla — kept in sync with DEFAULT_CLIENT_URL in
 * routes.ts and the SCAPE_CLIENT_URL plugin parameter in package.json.
 */
function resolveLaunchUrl(): string {
  const fromEnv = process.env.SCAPE_CLIENT_URL?.trim();
  return fromEnv && fromEnv.length > 0
    ? fromEnv
    : "https://scape-client-2sqyc.kinsta.page";
}

export const appScapePlugin = gatePluginSessionForHostedApp(
  createAppScapePlugin(),
  "@elizaos/app-scape",
);

export default appScapePlugin;

export { JournalStore } from "./journal/journal-store.js";
export type {
  JournalGoal,
  JournalMemory,
  JournalProgressEntry,
  JournalState,
} from "./journal/types.js";
export * from "./routes.js";
export { BotSdk } from "./sdk/index.js";
export type {
  AnyActionFrame,
  ClientFrame,
  PerceptionSnapshot,
  ServerFrame,
} from "./sdk/types.js";
export { BotManager } from "./services/bot-manager.js";
// Re-exports for tests and direct consumers (mirrors the 2004scape
// plugin's pattern so callers can grab the service class or SDK
// without plumbing through the default export).
export { ScapeGameService } from "./services/game-service.js";
export { JournalService } from "./services/journal-service.js";
export * from "./ui/index.js";
