// this just imported dotenv, settings will handle wrapping this
//import "./config.ts"; // Add this line first

/*
export * from "./actions.ts";
export * from "./context.ts";
export * from "./database.ts";
export * from "./embedding.ts";
export * from "./evaluators.ts";
export * from "./generation.ts";
export * from "./goals.ts";
export * from "./memory.ts";
*/
export * from './messages.ts';
//export * from "./models.ts";
export * from './posts.ts';
//export * from "./providers.ts";
//export * from "./relationships.ts";
export * from './runtime.ts';
/*
export * from "./settings.ts";
export * from "./types.ts";
export * from "./logger.ts";
export * from "./parsing.ts";
export * from "./uuid.ts";
export * from "./environment.ts";
export * from "./cache.ts";
export { default as knowledge } from "./knowledge.ts";
export * from "./ragknowledge.ts";
export * from "./utils.ts";
*/

// This is the entrypoint for the core-plugin-v1 package
// It exports everything needed for v1 plugin compatibility

// Core types
export * from './types.ts';

// Adapters created for v1 -> v2 compatibility
// Export only the adapter functions and V1 types to avoid conflicts
export { fromV2State, toV2State, State } from './state.ts';

export { asUUID, generateUuidFromString } from './uuid.ts';

export {
  fromV2ActionExample,
  toV2ActionExample,
  ActionExample,
  convertContentToV1,
  convertContentToV2,
} from './actionExample.ts';

export { fromV2Provider, toV2Provider, Provider } from './provider.ts';

export {
  createTemplateFunction,
  processTemplate,
  getTemplateValues,
  TemplateType,
} from './templates.ts';

// Existing exports
export * from './messages.ts';
export * from './posts.ts';
export * from './runtime.ts';

// TODO: Implement the remaining adapters:
// - action/handler
// - database
// - knowledge / memory
// - relationships
