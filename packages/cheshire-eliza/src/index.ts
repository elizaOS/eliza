export {
  CHESTER_CORE_PLUGINS,
  CHESTER_DOMAIN_PLUGINS,
  CHESTER_MODEL_PLUGINS,
  CHESTER_PLUGIN_BUNDLE,
  cheshireTerminalCharacter,
  solizardCheshireCharacter,
} from "./characters/solizard-cheshire.js";
export type { CheshireCharacter } from "./characters/solizard-cheshire.js";

export { generateAgentBody } from "./body-generator/index.js";
export type {
  BodyArchetype,
  BodyGeneratorInput,
  GeneratedAgentBody,
} from "./body-generator/index.js";

export {
  CLAWD_CODE_GITHUB,
  CLAWD_CODE_INSTALL_SH,
  CLAWD_INTEGRATION_EDGES,
  CLAWD_MONOREPO_PATHS,
  CLAWD_PACKAGE_NAMES,
  clawdStackSummary,
} from "./clawd-bridge.js";

/** Plugin package names shipped in this monorepo PR */
export const CHESHIRE_ELIZA_PLUGINS = [
  "@elizaos/plugin-robinhood",
  "@elizaos/plugin-solana-forging",
  "@elizaos/plugin-e2b-computer",
  "@elizaos/plugin-cheshire-memory",
  "@elizaos/plugin-clawdbrowser",
  "@elizaos/plugin-dflow-trade",
] as const;

/**
 * External CLI companions (not loaded as @elizaos Plugin modules).
 * Wired via plugins/clawd-plugin MCP bridge + operator install.
 */
export const CHESHIRE_CLAWD_CLI_COMPANIONS = [
  "@solana-clawd/clawd-code",
  "@solana-clawd/clawd-plugin",
] as const;
