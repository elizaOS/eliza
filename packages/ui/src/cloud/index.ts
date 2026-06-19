/**
 * Barrel for the app-hosted Eliza Cloud surfaces.
 *
 * Shared infrastructure (typed API client, react-query client, steward-session
 * glue) and the self-registering cloud-route registry live here. Domain modules
 * under `cloud/<domain>/` register their routes/sections against these
 * contracts; the app shell imports from `@elizaos/ui` via
 * `export * as cloud from "./cloud"`.
 */

export * from "./lib/api-client";
export * from "./lib/query-client";
export * from "./lib/steward-session";
export * from "./shell/cloud-route-registry";
