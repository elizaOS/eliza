import { appsService } from "../services/apps";

/**
 * App API keys (`apps.api_key_id`) are minted as plain org credentials with no
 * schema-level scope, so without this guard an app's own key can act on ANY
 * sibling app in the same org — delete it, redeploy it, rotate its key, or spend
 * org credits through its charge/image routes. (#10852)
 *
 * The correct scope is: an **app key is bound to its own app**; a normal **org
 * key owns no app and stays org-scoped** (unchanged behavior). We can't tell app
 * keys from org keys at the schema level (no `app_id`/scope column), so we
 * reverse-map the presented key through `apps.api_key_id`: if the key belongs to
 * a DIFFERENT app than the route's, reject.
 *
 * Returns the 403 reason string when the credential is a foreign app key, or
 * `null` when it is allowed for this app (org key, user auth, or the app's own
 * key).
 */
export async function appKeyScopeViolation(
  authMethod: string | undefined,
  apiKeyId: string | undefined,
  appId: string,
  lookup: (keyId: string) => Promise<{ id: string } | undefined> = (keyId) =>
    appsService.getByApiKeyId(keyId),
): Promise<string | null> {
  // User auth (session/JWT) is org-scoped by the existing org check — leave it.
  if (authMethod !== "api_key" || !apiKeyId) return null;
  const owningApp = await lookup(apiKeyId);
  // owningApp == undefined → an org key (not any app's key) → org-scoped, allow.
  // owningApp.id === appId  → the app's own key → allow.
  if (owningApp && owningApp.id !== appId) {
    return "This API key is scoped to a different app";
  }
  return null;
}

export const APP_KEY_SCOPE_FORBIDDEN = "This API key is scoped to a different app";
