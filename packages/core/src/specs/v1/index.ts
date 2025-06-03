// this just imported dotenv, settings will handle wrapping this

export * from './messages';
//export * from "./models";
export * from './posts';
//export * from "./providers";
//export * from "./relationships";
export * from './runtime';

/*
Core exports for Eliza SDK v1. This is the primary entrypoint for the SDK.
These are the v1 specs, which are a shim over the v2 specs for backwards compatibility.
*/

// Core types
export * from './types';

// Adapters created for v1 -> v2 compatibility
// Export only the adapter functions and V1 types to avoid conflicts
export { fromV2State, toV2State } from './state';
export type { State } from './state';

export { asUUID, generateUuidFromString } from './uuid';

export {
  fromV2ActionExample,
  toV2ActionExample,
  convertContentToV1,
  convertContentToV2,
} from './actionExample';

export type { ActionExample } from './actionExample';

export { fromV2Provider, toV2Provider } from './provider';

export type { Provider } from './provider';

export { createTemplateFunction, processTemplate, getTemplateValues } from './templates';

export type { TemplateType } from './templates';

// Existing exports
export * from './messages';
export * from './posts';
export * from './runtime';

// TODO: Implement the remaining adapters:
// - action/handler
// - database
// - knowledge / memory
// - relationships
