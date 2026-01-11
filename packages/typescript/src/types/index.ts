// Legacy types (for backwards compatibility)
export * from "./agent";
export * from "./components";
export * from "./database";
export * from "./environment";
export * from "./events";
export * from "./knowledge";
export * from "./memory";
export * from "./messaging";
export * from "./model";
export * from "./plugin";
export * from "./primitives";
export * from "./prompts";
// Proto-generated types (single source of truth)
// These types are generated from /schemas/eliza/v1/*.proto
// Use these for new code and cross-language interoperability
export * as proto from "./proto.js";
// Re-export proto utilities for JSON conversion
export { fromJson, type JsonObject, toJson } from "./proto.js";
export * from "./runtime";
export * from "./service";
export * from "./service-interfaces";
export * from "./settings";
export * from "./state";
export * from "./streaming";
export * from "./task";
export * from "./tee";
export * from "./testing";
