/**
 * Default organization roster for the engine.
 *
 * The canonical organization data lives in the `@feed/pack-default` content
 * pack. This module re-exports it so the engine's legacy `./data/organizations`
 * import path resolves to the single source of truth (no duplicated roster).
 */
export { organizations } from "@feed/pack-default";
