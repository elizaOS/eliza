/**
 * Per-app API key scoping (#10852).
 *
 * App-minted API keys (`apps.api_key_id`) are stored in `api_keys` with NO
 * app_id/scope column, so `requireUserOrApiKeyWithOrg` resolves them to a FULL
 * org `AuthedUser` — indistinguishable from a normal org key. Every `/apps/[id]/*`
 * route then gates only on `app.organization_id === user.organization_id`, so
 * App A's key can DELETE / rotate / deploy / spend against any sibling app B in
 * the same org. Only `characters/route.ts` app-scopes (via the reverse match
 * `app.api_key_id === apiKey.id`), proving the intent — realized nowhere else.
 *
 * This closes the hole without an `api_keys` schema migration by reverse-matching
 * the resolved key against `apps.api_key_id` (a lookup that already exists,
 * `appsService.getByApiKeyId`): if the credential IS an app key, it may only act
 * on its own app; a normal org key or session keeps full org access unchanged.
 */

/**
 * Pure predicate: is this an app key being used for a DIFFERENT app than the one
 * it belongs to?
 *
 * - `apiKeyId` absent → session auth → not cross-app (false).
 * - `owningAppId` absent → the key is a normal org key (no app claims it) → false.
 * - both present and differ → an app key used cross-app → true (deny).
 */
export function isCrossAppKeyUsage(params: {
  apiKeyId: string | null | undefined;
  owningAppId: string | null | undefined;
  requestedAppId: string;
}): boolean {
  return Boolean(
    params.apiKeyId && params.owningAppId && params.owningAppId !== params.requestedAppId,
  );
}

/**
 * Resolve whether the request's API key (if any) is an app key scoped to a
 * DIFFERENT app than `requestedAppId`. Returns true → the caller should 403.
 * `apiKeyId` is `undefined`/`null` for session auth (never out of scope).
 *
 * `appsService` is imported dynamically so this module — and the pure
 * predicate's unit tests — don't pull in the apps/DB layer.
 */
export async function isAppKeyOutOfScope(
  apiKeyId: string | null | undefined,
  requestedAppId: string,
): Promise<boolean> {
  if (!apiKeyId) return false;
  const { appsService } = await import("../services/apps");
  const owningApp = await appsService.getByApiKeyId(apiKeyId);
  return isCrossAppKeyUsage({
    apiKeyId,
    owningAppId: owningApp?.id,
    requestedAppId,
  });
}
