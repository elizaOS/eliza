export {
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

/** Plugin package names shipped in this monorepo PR */
export const CHESHIRE_ELIZA_PLUGINS = [
  "@elizaos/plugin-robinhood",
  "@elizaos/plugin-solana-forging",
  "@elizaos/plugin-e2b-computer",
  "@elizaos/plugin-cheshire-memory",
  "@elizaos/plugin-clawdbrowser",
] as const;
