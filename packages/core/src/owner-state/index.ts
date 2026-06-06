/**
 * @elizaos/core/owner-state
 *
 * Future home of owner-state services (owner facts, handoff tracking, global
 * pause, first-run flow, pending prompts) currently implemented inside
 * plugin-personal-assistant. The interfaces here are the stable contracts;
 * the `Stub*` classes are placeholders that throw "not implemented" so
 * consumers can wire types now and bind real implementations later.
 *
 * See README.md in this directory for the tracked migrations.
 */

export * from "./first-run.js";
export * from "./global-pause.js";
export * from "./handoff.js";
export * from "./owner-facts.js";
export * from "./pending-prompts.js";
