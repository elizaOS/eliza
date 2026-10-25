/**
 * Browser-safe display formatters for the analytics view.
 *
 * `toSuccessRatePercent` mirrors the pure helper in
 * `@elizaos/cloud-shared/lib/services/analytics-derived` but is re-declared here
 * because that module lives under the server-only `lib/services` tree (it
 * imports a Drizzle DB repository type) and must not be pulled into a browser UI
 * bundle. This is display formatting (a 0..1 fraction → a 0..100 percent for
 * rendering), not business computation — the canonical derived values still
 * come from the DTO.
 */

/** Convert a 0..1 success-rate fraction to a 0..100 percent (1dp). */
export function toSuccessRatePercent(rate: number): number {
  return Math.round(rate * 100 * 10) / 10;
}
