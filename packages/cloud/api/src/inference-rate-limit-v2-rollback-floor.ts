/**
 * Establishes the Cloudflare lifecycle boundary for the v2 inference rate-limit cutover.
 *
 * The class is intentionally unbound: its namespace exists only so Cloudflare rejects
 * rollbacks to Workers that predate the persisted cutover coordinator. The baseline
 * release still uses that coordinator, making it a safe target for later hot-path
 * releases that address the v2 object directly.
 */
export class InferenceRateLimitV2RollbackFloor {}
