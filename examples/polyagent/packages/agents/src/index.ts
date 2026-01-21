/**
 * Polyagent - Autonomous Polymarket Trading Agents
 *
 * This package provides the core agent infrastructure for the
 * Polyagent platform:
 * - Agent services (creation, management)
 * - Agent identity and wallet management
 * - Polymarket plugin wrapper for trading
 * - Agent0 integration for on-chain reputation
 */

// Communication
export * from "./communication/CommunicationHub";
export * from "./communication/EventBus";
// Errors
export * from "./errors";
// External agent adapter
export {
  type AgentResponse,
  AuthMethod,
  ExternalAgentAdapter,
  type ExternalAgentConnection,
  type ExternalAgentMessage,
  getExternalAgentAdapter,
  type Protocol,
} from "./external/ExternalAgentAdapter";
// Identity and wallet management
export * from "./identity/AgentIdentityService";
export * from "./identity/AgentWalletService";
// LLM integrations
export * from "./llm";
// Plugin utilities
export { groqPlugin } from "./plugins/groq";
export * from "./plugins/plugin-autonomy/src";
export * from "./plugins/plugin-experience/src";
export * from "./plugins/plugin-trajectory-logger/src";
// Polymarket plugin wrapper
export {
  babylonPolymarketPlugin,
  getPolymarketService,
  type PolymarketAgentConfig,
  waitForPolymarketService,
} from "./plugins/polymarket";
// Runtime
export * from "./runtime/AgentRuntimeManager";
// Services
export * from "./services";
// Templates loader
export * from "./templates-loader";
// Core types
export * from "./types";
export * from "./types/agent-template";
export * from "./types/goals";
// Utils
export * from "./utils/createTestAgent";
export * from "./utils/prompt-builder";
