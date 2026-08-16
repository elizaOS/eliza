/**
 * Zod schemas for the apps-loading HTTP routes (the
 * directory-load surface that produced the App Permissions PR's
 * registry entries).
 *
 * Second migration in the typed-routes initiative — the App Permissions
 * routes were the pilot in `./app-permissions-routes.ts`. The pattern
 * (schema in shared, safeParse on server, infer types on client) is
 * the same here. Host-platform path semantics remain at the server boundary so
 * this browser-safe contract does not depend on, or emulate, Node's path API.
 *
 * Routes covered:
 *   POST /api/apps/load-from-directory
 *     body:    { directory: string }   (must be absolute)
 *     200:     { ok: true, directory, registered: number,
 *                items: [{slug, canonicalName}],
 *                rejectedManifests: [{directory, packageName,
 *                                      reason, path}] }
 *     400:     directory missing / not absolute / not a string
 *     503:     AppRegistryService not on runtime
 *     500:     filesystem failure during scan
 */

import z from "zod";

export const PostLoadFromDirectoryRequestSchema = z
  .object({
    directory: z.string().min(1, "directory is required"),
  })
  .strict();

const RegisteredItemSchema = z
  .object({
    slug: z.string().min(1),
    canonicalName: z.string().min(1),
  })
  .strict();

const RejectedManifestSchema = z
  .object({
    directory: z.string(),
    packageName: z.union([z.string(), z.null()]),
    reason: z.string(),
    path: z.string(),
  })
  .strict();

export const PostLoadFromDirectoryResponseSchema = z
  .object({
    ok: z.literal(true),
    directory: z.string(),
    registered: z.number().int().nonnegative(),
    items: z.array(RegisteredItemSchema),
    rejectedManifests: z.array(RejectedManifestSchema),
  })
  .strict();

export type PostLoadFromDirectoryRequest = z.infer<
  typeof PostLoadFromDirectoryRequestSchema
>;
export type PostLoadFromDirectoryResponse = z.infer<
  typeof PostLoadFromDirectoryResponseSchema
>;
export type LoadFromDirectoryRegisteredItem = z.infer<
  typeof RegisteredItemSchema
>;
export type LoadFromDirectoryRejectedManifest = z.infer<
  typeof RejectedManifestSchema
>;
