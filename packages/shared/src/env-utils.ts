/**
 * Shared environment variable utilities.
 *
 * `isTruthyEnvValue` is owned by `@elizaos/core` (canonical truthy set
 * `1/true/yes/y/on/enabled`) and re-exported from
 * `@elizaos/core/client-public` so existing `@elizaos/shared` consumers keep
 * their import path without pulling the prebuilt core browser blob. Do not
 * reach into `packages/core/src`.
 */
export { isTruthyEnvValue } from "@elizaos/core/client-public";
