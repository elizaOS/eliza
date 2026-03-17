/**
 * Type augmentation for Capacitor plugin modules used by Eliza Home.
 *
 * Only the agent and desktop plugins are needed for the chat-only app.
 */

declare module "@elizaos/capacitor-agent" {
  export { Agent } from "../plugins/agent/src/index";
  export type {
    AgentPlugin,
    AgentStatus,
    ChatResult,
  } from "../plugins/agent/src/definitions";
}

declare module "@elizaos/capacitor-desktop" {
  export { Desktop } from "../plugins/desktop/src/index";
  export type { DesktopPlugin } from "../plugins/desktop/src/definitions";
}
