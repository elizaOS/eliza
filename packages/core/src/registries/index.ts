/**
 * @elizaos/core/registries
 *
 * Future home of cross-cutting registries (anchors, gates, event kinds,
 * escalation ladders, family, blockers) currently implemented inside
 * plugin-personal-assistant. The interfaces are stable contracts; the
 * concrete implementations are stubs that throw "not implemented" until the
 * migration tracked in README.md happens.
 */

export * from "./anchor.js";
export * from "./blocker.js";
export * from "./escalation-ladder.js";
export * from "./event-kind.js";
export * from "./family.js";
export * from "./gate.js";
