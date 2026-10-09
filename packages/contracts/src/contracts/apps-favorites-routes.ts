/**
 * Zod schemas for the apps-favorites HTTP routes — the per-user
 * favorited-apps store. Fourth migration in the typed-routes
 * initiative; same template as the rest.
 *
 * Routes covered:
 *   GET  /api/apps/favorites
 *     200: { favoriteApps: string[] }            (no body to validate)
 *   PUT  /api/apps/favorites
 *     body: { appName: string, isFavorite: boolean }
 *     200:  { favoriteApps: string[] }
 *   POST /api/apps/favorites/replace
 *     body: { favoriteAppNames: string[] }
 *     200:  { favoriteApps: string[] }
 *
 * Server-side, all three routes already pipe their writes through
 * `sanitizeFavoriteAppNames(...)` — the schema's job is to reject
 * malformed inputs at the wire boundary; sanitization stays as a
 * second pass on top of validated data.
 */

import z from "zod";

export const PutFavoriteAppRequestSchema = z
  .object({
    appName: z.string().min(1, "appName is required"),
    isFavorite: z.boolean(),
  })
  .strict()
  .transform((value) => ({
    appName: value.appName.trim(),
    isFavorite: value.isFavorite,
  }))
  .pipe(
    z
      .object({
        appName: z.string().min(1, "appName is required"),
        isFavorite: z.boolean(),
      })
      .strict(),
  );

export const PostReplaceFavoritesRequestSchema = z
  .object({
    favoriteAppNames: z.array(z.string()),
  })
  .strict();

export const FavoritesResponseSchema = z
  .object({
    favoriteApps: z.array(z.string()),
  })
  .strict();

export type PutFavoriteAppRequest = z.infer<typeof PutFavoriteAppRequestSchema>;
export type PostReplaceFavoritesRequest = z.infer<
  typeof PostReplaceFavoritesRequestSchema
>;
export type FavoritesResponse = z.infer<typeof FavoritesResponseSchema>;
