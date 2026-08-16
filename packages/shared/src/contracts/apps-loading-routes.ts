/**
 * Zod schemas for the apps-loading HTTP routes (the
 * directory-load surface that produced the App Permissions PR's
 * registry entries).
 *
 * Second migration in the typed-routes initiative — the App Permissions
 * routes were the pilot in `./app-permissions-routes.ts`. The pattern
 * (schema in shared, safeParse on server, infer types on client) is
 * the same here; the only new wrinkle is `.refine()` for the
 * absolute-path check that previously lived as a hand-rolled `if
 * (!path.isAbsolute(directory))` guard in the route handler.
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

/**
 * Match `path.isAbsolute` without importing a Node-only module into the shared
 * browser-safe contract barrel. Windows accepts rooted slash/backslash paths
 * and drive-rooted paths; POSIX requires a leading slash.
 */
function isAbsoluteDirectoryPath(value: string): boolean {
  const platform =
    typeof process === "undefined" ? undefined : process.platform;
  if (platform === "win32") {
    return /^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
  }
  return value.startsWith("/");
}

export const PostLoadFromDirectoryRequestSchema = z
  .object({
    directory: z
      .string()
      .min(1, "directory is required")
      .refine(isAbsoluteDirectoryPath, {
        message: "directory must be an absolute path",
      }),
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
