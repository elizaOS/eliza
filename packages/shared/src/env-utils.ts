/**
 * Shared environment variable utilities.
 *
 * `isTruthyEnvValue` is owned by `@elizaos/core` (canonical truthy set
 * `1/true/yes/y/on/enabled`) and re-exported here so existing
 * `@elizaos/shared` consumers keep their import path. The core symbol is
 * exported from both the node and browser barrels, so this re-export resolves
 * in browser bundles too.
 */
export { isTruthyEnvValue } from "@elizaos/core";
