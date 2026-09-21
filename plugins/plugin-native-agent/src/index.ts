/**
 * TS host for the `Agent` Capacitor plugin: registers "Agent" with the
 * Capacitor runtime and re-exports the shared type definitions consumed by
 * both the web fallback and the native iOS/Android bridges.
 */
import { registerPlugin } from "@capacitor/core";
import type { AgentPlugin } from "./definitions.js";

export * from "./definitions.js";

export const Agent = registerPlugin<AgentPlugin>("Agent", {
  web: () => import("./web.js").then((m) => new m.AgentWeb()),
  // Electrobun uses the preload bridge (agent:start, agent:stop, etc.)
  // iOS/Android use the native bridge when registered, otherwise the HTTP web fallback.
});
