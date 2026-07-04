/**
 * Canonical roles barrel used by runtime bootstrap and internal imports. Points
 * at the in-repo roles implementation so the runtime, tests, and helper exports
 * all share one role contract.
 */
export * from "./roles/src/index.ts";
export { default } from "./roles/src/index.ts";
