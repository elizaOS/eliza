/**
 * LifeOps service constants (canonical, runtime-level).
 *
 * Plain constant tables consumed by the personal-assistant scheduled-task,
 * reminder, and connector pipelines. Depends only on the LifeOps contract types
 * (mirrored in `@elizaos/shared`); no DB, no plugin imports.
 */

export * from "./service-constants.js";
