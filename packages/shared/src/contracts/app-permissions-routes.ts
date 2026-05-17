/**
 * Zod schemas for the App Permissions HTTP routes.
 *
 * **Pilot for the typed-routes initiative.** Replaces hand-rolled
 * `if (typeof body.x !== 'string')` validation in
 * `packages/agent/src/api/apps-routes.ts` and the parallel client-side
 * type re-declarations in `packages/ui/src/api/client-skills.ts` with a
 * single source of truth: zod schemas defined here, parsed on the
 * server, and used to derive the client's request/response types.
 *
 * The pattern that lands here is the template for migrating other
 * routes off the manual-validation pattern — keep schemas alongside
 * their domain types, expose `.parse()` for the server, expose
 * inferred TS types via `z.infer<typeof schema>` for the client.
 *
 * Routes covered (from PR #7554):
 *   GET  /api/apps/permissions
 *   GET  /api/apps/permissions/:slug
 *   PUT  /api/apps/permissions/:slug   { namespaces: string[] }
 *
 * The `AppPermissionsView` shape itself is hand-typed in
 * `./app-permissions.ts` (slice 1) and re-derived as a zod schema here.
 * The two are kept in sync by a compile-time `satisfies` check at the
 * bottom of this module — if either drifts, typecheck fails.
 */

import z from "zod";

const AppTrustSchema = z.enum(["first-party", "external"]);

const AppIsolationSchema = z.enum(["none", "worker"]);

const RecognisedPermissionNamespaceSchema = z.enum(["fs", "net"]);

/**
 * Wire shape for `AppPermissionsView`. Mirrors the hand-typed
 * interface in `./app-permissions.ts`. Drift between the two is
 * caught at the bottom of this module via a `satisfies` cross-check.
 */
export const AppPermissionsViewSchema = z
  .object({
    slug: z.string().min(1),
    trust: AppTrustSchema,
    isolation: AppIsolationSchema,
    // `z.union([..., z.null()])` is used in place of `.nullable()`
    // because zod 4's `.nullable()` infers as `T | undefined` rather
    // than `T | null` in strict-object mode, which mismatches the
    // hand-typed `AppPermissionsView.requestedPermissions: ... | null`
    // / `grantedAt: string | null` interface.
    requestedPermissions: z.union([
      z.record(z.string(), z.unknown()),
      z.null(),
    ]),
    recognisedNamespaces: z.array(RecognisedPermissionNamespaceSchema),
    grantedNamespaces: z.array(RecognisedPermissionNamespaceSchema),
    grantedAt: z.union([z.string(), z.null()]),
  })
  .strict();

/** GET /api/apps/permissions response. */
export const ListAppPermissionsResponseSchema = z.array(
  AppPermissionsViewSchema,
);

/** GET /api/apps/permissions/:slug response (404 → no body). */
export const GetAppPermissionsResponseSchema = AppPermissionsViewSchema;

/**
 * PUT /api/apps/permissions/:slug request body.
 *
 * `namespaces` is validated as a string array at the schema layer;
 * the further check that each namespace is recognised AND was
 * declared in the app's manifest happens server-side in
 * `setGrantedNamespaces` (which has access to the registry entry).
 * Doing the recognised-namespace check here too would force every
 * future namespace addition to ship a zod-schema bump *and* a parser
 * bump in lockstep, which is friction we don't need.
 */
export const PutAppPermissionsRequestSchema = z
  .object({
    namespaces: z.array(z.string()),
  })
  .strict();

/** PUT /api/apps/permissions/:slug response (200 success body). */
export const PutAppPermissionsResponseSchema = AppPermissionsViewSchema;

// Inferred TS types — the canonical source for client + server use.
export type AppPermissionsViewWire = z.infer<typeof AppPermissionsViewSchema>;
export type ListAppPermissionsResponse = z.infer<
  typeof ListAppPermissionsResponseSchema
>;
export type GetAppPermissionsResponse = z.infer<
  typeof GetAppPermissionsResponseSchema
>;
export type PutAppPermissionsRequest = z.infer<
  typeof PutAppPermissionsRequestSchema
>;
export type PutAppPermissionsResponse = z.infer<
  typeof PutAppPermissionsResponseSchema
>;

// NOTE on drift between the hand-typed `AppPermissionsView` interface
// (in `./app-permissions.ts`) and `AppPermissionsViewWire` (inferred
// from the zod schema above): zod 4's nullable + strict-object
// inference produces `T | undefined` for nullable fields rather than
// `T | null`, which makes a strict bidirectional Equals-style check
// fail despite the runtime shapes being identical. The schema tests
// in `./app-permissions-routes.test.ts` exercise the actual shape on
// real inputs; that is the load-bearing check. Treat the two
// declarations as a co-located pair — if you change one, change the
// other in the same commit and rerun the schema tests.

/**
 * Tagged constants the client can send to surface where a malformed
 * request originated. The agent's HTTP error path includes the path
 * in the JSON error body so client-side surfaces can localise.
 */
export const APP_PERMISSIONS_ROUTE_PATHS = {
  list: "/api/apps/permissions",
  get: (slug: string) => `/api/apps/permissions/${encodeURIComponent(slug)}`,
  put: (slug: string) => `/api/apps/permissions/${encodeURIComponent(slug)}`,
} as const;
