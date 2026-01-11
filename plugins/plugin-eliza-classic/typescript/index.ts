/**
 * Classic ELIZA Plugin for elizaOS
 *
 * Provides a TEXT_LARGE and TEXT_SMALL model handler using the original
 * ELIZA pattern matching algorithm from Joseph Weizenbaum's 1966 program.
 * No LLM required - pure pattern matching.
 */

export * from "./models";
export { generateElizaResponse, getElizaGreeting } from "./models/text";
export { elizaClassicPlugin, elizaClassicPlugin as default } from "./plugin";
export * from "./types";
