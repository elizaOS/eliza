/**
 * @elizaos/logger — the structured logger used across elizaOS.
 *
 * Extracted from `@elizaos/core` so UI/renderer code (and any consumer that
 * only needs logging) can import the logger without pulling the entire core
 * runtime bundle into its module graph. `@elizaos/core` re-exports everything
 * here, so existing `import { logger } from "@elizaos/core"` call sites are
 * unchanged.
 *
 * NOTE: `./env` (getEnv) is an internal helper for the logger only — it is
 * deliberately NOT re-exported here, because `@elizaos/core` has its own
 * `getEnv` from its environment utils and re-exporting this one would create a
 * duplicate-export ambiguity in core's barrels.
 */
export * from "./logger.js";
export { default } from "./logger.js";
//# sourceMappingURL=index.d.ts.map