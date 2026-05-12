// Canonical roles plugin barrel used by runtime bootstrap and internal imports.
// Keep this pointed at the in-repo implementation so the runtime, tests, and
// helper exports all share the same contract.

export * from "./roles/src/index.ts";
export { default } from "./roles/src/index.ts";
