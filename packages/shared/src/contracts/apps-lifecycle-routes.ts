/**
 * Zod schemas for the apps-lifecycle HTTP routes
 * (launch / install / stop / relaunch / create / overlay-presence /
 * refresh). Same template as the rest: schema in shared, safeParse on
 * server, infer types on client.
 *
 * Routes covered:
 *   POST /api/apps/launch            body: { name }                  → AppLaunchResult
 *   POST /api/apps/install           body: { name, version? }        → InstallAppResponse
 *   POST /api/apps/stop              body: { name?, runId? }         → AppStopResult
 *                                     (at least one of name/runId required)
 *   POST /api/apps/relaunch          body: { name, runId?, verify? } → AppLaunchResult
 *   POST /api/apps/create            body: { intent, editTarget? }   → CreateAppResponse
 *   POST /api/apps/overlay-presence  body: { appName?: string|null } → OverlayPresenceResponse
 *   POST /api/apps/refresh           (no body)                       → RefreshAppsResponse
 *
 * Response shapes for the routes that delegate to AppLaunchResult or
 * AppStopResult (launch, stop, relaunch) are still defined by the
 * TypeScript interfaces in `./apps.ts` — those tree types have not
 * been migrated to zod yet and are out of scope for this module.
 */

import z from "zod";

/** Request body shared by /launch and /install. */
const NameOnlyRequestBase = z
  .object({
    name: z.string().min(1, "name is required"),
  })
  .strict();

/** Trims `name` to match the server's pre-zod normalisation. */
const trimName = <T extends { name: string }>(value: T): T => ({
  ...value,
  name: value.name.trim(),
});

export const PostLaunchAppRequestSchema = NameOnlyRequestBase.transform(
  trimName,
).pipe(z.object({ name: z.string().min(1, "name is required") }).strict());

export const PostInstallAppRequestSchema = z
  .object({
    name: z.string().min(1, "name is required"),
    version: z.string().min(1).optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    name: value.name.trim(),
    ...(value.version ? { version: value.version.trim() } : {}),
  }))
  .pipe(
    z
      .object({
        name: z.string().min(1, "name is required"),
        version: z.string().min(1).optional(),
      })
      .strict(),
  );

/**
 * /stop accepts `{ name }`, `{ runId }`, or both — but at least one
 * must be a non-empty string. The `.refine()` does the cross-field
 * check the route used to do by hand.
 */
export const PostStopAppRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.name && value.name.trim().length > 0) ||
      (value.runId && value.runId.trim().length > 0),
    { message: "name or runId is required" },
  )
  .transform((value) => ({
    ...(value.name ? { name: value.name.trim() } : {}),
    ...(value.runId ? { runId: value.runId.trim() } : {}),
  }));

/**
 * /relaunch accepts the launch fields plus optional `runId` (used to
 * stop a specific run before relaunching, instead of the broader
 * "stop everything matching `name`" behaviour) and a `verify`
 * boolean that triggers post-launch verification. The route already
 * required `name` even when `runId` was supplied — so no
 * cross-field refine like /stop has.
 */
export const PostRelaunchAppRequestSchema = z
  .object({
    name: z.string().min(1, "name is required"),
    runId: z.string().min(1).optional(),
    verify: z.boolean().optional(),
  })
  .strict()
  .transform((value) => ({
    name: value.name.trim(),
    ...(value.runId ? { runId: value.runId.trim() } : {}),
    ...(typeof value.verify === "boolean" ? { verify: value.verify } : {}),
  }))
  .pipe(
    z
      .object({
        name: z.string().min(1, "name is required"),
        runId: z.string().min(1).optional(),
        verify: z.boolean().optional(),
      })
      .strict(),
  );

/**
 * /create maps onto the unified APP action — the `intent` is the
 * natural-language prompt the orchestrator hands to the spawned coding
 * sub-agent, and `editTarget` (when present) names an existing app to
 * edit instead of scaffolding a new one. The handler used to require a
 * non-empty trimmed intent by hand; the schema now does that, plus
 * trims `editTarget` so empty strings round-trip back to "missing".
 */
export const PostCreateAppRequestSchema = z
  .object({
    intent: z.string().min(1, "intent is required"),
    editTarget: z.string().min(1).optional(),
  })
  .strict()
  .transform((value) => ({
    intent: value.intent.trim(),
    ...(value.editTarget ? { editTarget: value.editTarget.trim() } : {}),
  }))
  .pipe(
    z
      .object({
        intent: z.string().min(1, "intent is required"),
        editTarget: z.string().min(1).optional(),
      })
      .strict(),
  );

/**
 * /overlay-presence is the UI's "which app is currently visible" ping.
 * The route accepts a string, an explicit `null`, or omission — all of
 * the latter two clear presence. Empty/whitespace strings collapse to
 * null too, matching the handler's prior `trim().length > 0 ? trim : null`
 * normalisation.
 */
export const PostOverlayPresenceRequestSchema = z
  .object({
    appName: z.union([z.string(), z.null()]).optional(),
  })
  .strict()
  .transform((value): { appName: string | null } => {
    const raw = value.appName;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return { appName: trimmed.length > 0 ? trimmed : null };
  });

// ── Response schemas ─────────────────────────────────────────────────
//
// Only the inline ad-hoc shapes the handlers produce are modelled here.
// Routes returning AppLaunchResult / AppStopResult (launch, relaunch,
// stop) keep using the TS interfaces in `./apps.ts` — migrating those
// tree types is a separate pass.

/** /overlay-presence reply: `{ ok: true, appName: string | null }`. */
export const PostOverlayPresenceResponseSchema = z
  .object({
    ok: z.literal(true),
    appName: z.union([z.string().min(1), z.null()]),
  })
  .strict();

/** /create reply from the unified APP action. */
export const PostCreateAppResponseSchema = z
  .object({
    success: z.boolean(),
    text: z.string(),
    messages: z.array(z.string()),
    data: z.unknown(),
  })
  .strict();

/** /refresh reply — registry refresh count. */
export const PostRefreshAppsResponseSchema = z
  .object({
    ok: z.literal(true),
    count: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Component schema: install-progress event the installer streams as it
 * walks through phases (download, extract, register, …). Mirrors the
 * `InstallProgressLike` interface in
 * `packages/agent/src/services/plugin-manager-types.ts`.
 */
export const InstallProgressEventSchema = z
  .object({
    phase: z.string(),
    message: z.string(),
    pluginName: z.string().optional(),
  })
  .strict();

/**
 * /install reply, discriminated on `success`:
 *   - success: full install metadata + replayed progress events
 *   - failure: error + the progress events that were captured before
 *     the failure
 */
export const PostInstallAppResponseSchema = z.discriminatedUnion("success", [
  z
    .object({
      success: z.literal(true),
      pluginName: z.string(),
      version: z.string(),
      installPath: z.string(),
      requiresRestart: z.boolean(),
      progress: z.array(InstallProgressEventSchema),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      error: z.string().optional(),
      progress: z.array(InstallProgressEventSchema),
    })
    .strict(),
]);

export type PostLaunchAppRequest = z.infer<typeof PostLaunchAppRequestSchema>;
export type PostInstallAppRequest = z.infer<typeof PostInstallAppRequestSchema>;
export type PostStopAppRequest = z.infer<typeof PostStopAppRequestSchema>;
export type PostRelaunchAppRequest = z.infer<
  typeof PostRelaunchAppRequestSchema
>;
export type PostCreateAppRequest = z.infer<typeof PostCreateAppRequestSchema>;
export type PostOverlayPresenceRequest = z.infer<
  typeof PostOverlayPresenceRequestSchema
>;
export type PostOverlayPresenceResponse = z.infer<
  typeof PostOverlayPresenceResponseSchema
>;
export type PostCreateAppResponse = z.infer<typeof PostCreateAppResponseSchema>;
export type PostRefreshAppsResponse = z.infer<
  typeof PostRefreshAppsResponseSchema
>;
export type InstallProgressEvent = z.infer<typeof InstallProgressEventSchema>;
export type PostInstallAppResponse = z.infer<
  typeof PostInstallAppResponseSchema
>;
