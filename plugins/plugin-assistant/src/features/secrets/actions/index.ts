/**
 * Actions module exports.
 *
 * The only planner-facing action is `SECRETS` (exported as `secretsAction`).
 * Atomic operations live in sibling files as plain handler functions and are
 * dispatched by the umbrella's discriminator (`action=get|set|...`).
 */

export { maskSecretValue, secretsAction } from "./manage-secret.ts";
