/**
 * Inter-organization correlations for the default pack.
 *
 * The canonical correlations live in the `@feed/pack-default` content pack
 * (migrated from the engine's original MarketCorrelation format to
 * `OrgCorrelation`). This module re-exports them so the engine's legacy
 * `./data/organization-correlations` import path resolves to the single source
 * of truth.
 */
export { correlations } from "@feed/pack-default";
