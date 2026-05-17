/**
 * Vault inventory + profile + routing API routes.
 *
 *   GET    /api/secrets/inventory                   → VaultEntryMeta[]
 *                                                    (no values; loopback gate only — list is meta)
 *   GET    /api/secrets/inventory/:key              → reveal active-profile value
 *                                                    (sensitive → ensureCompatSensitiveRouteAuthorized)
 *   PUT    /api/secrets/inventory/:key              → upsert { value, label?, providerId?, category? }
 *                                                    (sensitive)
 *   DELETE /api/secrets/inventory/:key              → drop key + meta + every profile
 *                                                    (sensitive)
 *
 *   GET    /api/secrets/inventory/:key/profiles     → profile list (no values)
 *                                                    (loopback)
 *   POST   /api/secrets/inventory/:key/profiles     → add { id, label, value }
 *                                                    (sensitive)
 *   PATCH  /api/secrets/inventory/:key/profiles/:id → update { label?, value? }
 *                                                    (sensitive)
 *   DELETE /api/secrets/inventory/:key/profiles/:id → drop profile
 *                                                    (sensitive)
 *   PUT    /api/secrets/inventory/:key/active-profile → { profileId }
 *                                                    (sensitive)
 *
 *   GET    /api/secrets/routing                     → RoutingConfig
 *   PUT    /api/secrets/routing                     → save RoutingConfig
 *                                                    (sensitive — names internal config)
 *
 *   POST   /api/secrets/inventory/migrate-to-profiles
 *                                                    → opt-in: copy plain `<KEY>` value
 *                                                       into `<KEY>.profile.default` and write
 *                                                       _meta.<KEY>. Idempotent.
 *
 * The "sensitive" gate matches `PUT /api/secrets/manager/preferences`:
 * loopback-from-this-machine OR a configured compat API token. We do
 * not loosen that boundary.
 */
import type http from "node:http";
export declare function handleSecretsInventoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean>;
//# sourceMappingURL=secrets-inventory-routes.d.ts.map
