/**
 * Interactive message protocol — the connector-agnostic engine for parsing,
 * serializing, and laying out the interaction blocks an agent embeds in a reply
 * (forms, choice pickers, suggestion chips, task cards, secret requests).
 *
 * Types live in `@elizaos/core` `types/interactions`; this module is the pure
 * runtime: shared by the dashboard, the connectors, and the runtime's outbound
 * normalization. No React, no Node-only APIs.
 */

export * from "./callback";
export * from "./dashboard-markers";
export * from "./host";
export * from "./layout";
export * from "./normalize";
export * from "./parse";
export * from "./profile-catalog";
export * from "./profiles";
export * from "./serialize";
export * from "./sessions";
