/**
 * Shared environment variable utilities.
 *
 * `isTruthyEnvValue` is the single `@elizaos/core` implementation, also
 * exported from `@elizaos/core/client-public`. Shared re-exports the source
 * file so `packages/app/vite.config.ts` can load this module at config eval
 * without resolving the client-public package subpath to an unbuilt `dist/`
 * (#18056 / #18704). Do not put a second function body here.
 */

export { isTruthyEnvValue } from "../../core/src/env-utils.ts";
