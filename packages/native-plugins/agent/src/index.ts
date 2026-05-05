import { registerPlugin } from "@capacitor/core";
import type { AgentPlugin } from "./definitions";

export * from "./definitions";

export const Agent = registerPlugin<AgentPlugin>("Agent", {
  web: () => import("./web").then((m) => new m.AgentWeb()),
  // Electrobun uses the preload bridge (agent:start, agent:stop, etc.)
  // iOS/Android will use the web fallback (HTTP to API server) for now
});
