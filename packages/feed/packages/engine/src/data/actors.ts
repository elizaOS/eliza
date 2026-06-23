/**
 * Default actor roster for the engine.
 *
 * The canonical actor data lives in the `@feed/pack-default` content pack. This
 * module re-exports it so the engine's legacy `./data/actors` import path
 * resolves to the single source of truth (no duplicated roster).
 */
export { actors } from "@feed/pack-default";
