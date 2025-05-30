// this just imported dotenv, settings will handle wrapping this
//import "./config"; // Add this line first

/*
export * from "./actions";
export * from "./context";
export * from "./database";
export * from "./embedding";
export * from "./evaluators";
export * from "./generation";
export * from "./goals";
export * from "./memory";
*/
export * from './messages';
//export * from "./models";
export * from './posts';
//export * from "./providers";
//export * from "./relationships";
export * from './runtime';
/*
export * from "./settings";
export * from "./types";
export * from "./logger";
export * from "./parsing";
export * from "./uuid";
export * from "./environment";
export * from "./cache";
export { default as knowledge } from "./knowledge";
export * from "./ragknowledge";
export * from "./utils";
*/

// This is the entrypoint for the core-plugin-v1 package
// It exports everything needed for v1 plugin compatibility

// Core types
export * from './types';

// Adapters created for v1 -> v2 compatibility
// Export only the adapter functions and V1 types to avoid conflicts
export { fromV2State, toV2State, State } from './state';

export { asUUID, generateUuidFromString } from './uuid';

export {
  fromV2ActionExample,
  toV2ActionExample,
  ActionExample,
  convertContentToV1,
  convertContentToV2,
} from './actionExample';

export { fromV2Provider, toV2Provider, Provider } from './provider';

export {
  createTemplateFunction,
  processTemplate,
  getTemplateValues,
  TemplateType,
} from './templates';

// Existing exports
export * from './messages';
export * from './posts';
export * from './runtime';

// TODO: Implement the remaining adapters:
// - action/handler
// - database
// - knowledge / memory
// - relationships
