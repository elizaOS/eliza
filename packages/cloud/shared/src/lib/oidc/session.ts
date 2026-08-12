/**
 * Cookie-only session resolution for the OIDC authorization endpoint.
 *
 * This deliberately does NOT call `getCurrentUser(c)`. That resolver accepts a
 * Bearer JWT and JIT-provisions an account on a miss, and neither belongs in an
 * authorization redirect: `/authorize` is a top-level browser navigation, so a
 * Bearer could only come from a non-browser caller, and account creation must
 * not be a side effect of a relying party sending a user here.
 *
 * The cookie reaches this endpoint because `steward-token` is scoped to
 * `Domain=elizacloud.ai` and `SameSite=Lax`, which is sent on a cross-site
 * top-level GET. Two consequences worth knowing: a change to `SameSite=Strict`
 * silently breaks SSO with a "not signed in" loop, and — because sibling
 * `*.elizacloud.ai` hosts serve user content and JS there can PLANT a
 * parent-domain cookie — the explicit-logout marker check below is load-bearing
 * rather than optional.
 *
 * The session's Steward tenant is deliberately NOT carried into the claim
 * builder. `/userinfo` runs with an access token and no session, so a
 * session-derived claim would exist in the ID token and vanish on the next read;
 * `tenant_id` therefore comes from stored rows only (see `./claims.ts`).
 *
 * NOTHING HERE IS AN AUTHENTICATION TIME. A Steward access token is re-minted
 * on every refresh from already-verified claims (`auth/steward-refresh`), so
 * its `iat` moves without the user authenticating; a session established weeks
 * ago carries an `iat` from minutes ago. `issuedAt` is therefore used ONLY to
 * order this token against the explicit-logout marker, and no `auth_time` claim
 * is derived from it — see `./tokens.ts`.
 */

import type { AppContext } from "../../types/cloud-worker-env";
import { verifyStewardTokenCached } from "../auth/steward-client";
import { readStewardAccessCookieFromHeader } from "../auth/steward-cookies";
import { isBlockedBySsoBridgeLogout } from "../services/sso-bridge-codes";
import { usersService } from "../services/users";

export interface OidcSession {
  stewardUserId: string;
  userId: string;
  /** `iat` of the session token — logout-marker ordering input. */
  issuedAt: number;
}

export type OidcSessionOutcome =
  | { status: "authenticated"; session: OidcSession }
  | { status: "signed_out" }
  | { status: "signed_out_after_logout" };

/**
 * Resolve the browser's Eliza Cloud session, or report that there is none.
 *
 * Throws on a store failure so the route boundary answers 503 — an unreadable
 * logout-marker store must never read as "not logged out".
 */
export async function resolveOidcSession(c: AppContext): Promise<OidcSessionOutcome> {
  const token = readStewardAccessCookieFromHeader(
    c.req.header("cookie") ?? null,
    c.env?.ENVIRONMENT,
  );
  if (!token) return { status: "signed_out" };

  const claims = await verifyStewardTokenCached(c.env, token);
  if (!claims) return { status: "signed_out" };

  // The staging QA session is intentionally non-transferable. Letting it
  // authorize an OIDC client would mint ordinary OIDC tokens that no longer
  // carry or continuously revalidate the source-key/user/org binding.
  if (claims.stagingSessionBinding) return { status: "signed_out" };

  if (await isBlockedBySsoBridgeLogout(claims.userId, claims.issuedAt)) {
    // The user explicitly signed out after this token was issued. Honoring the
    // still-unexpired cookie would mint a brand-new relying-party session out
    // of a session the platform already considers ended.
    return { status: "signed_out_after_logout" };
  }

  // No JIT provisioning: a browser holding a Cloud cookie was provisioned by
  // the login path already, and a miss here means the session does not map to
  // a real account.
  const user = await usersService.getByStewardId(claims.userId);
  if (!user) return { status: "signed_out" };

  return {
    status: "authenticated",
    session: {
      stewardUserId: claims.userId,
      userId: user.id,
      issuedAt: claims.issuedAt,
    },
  };
}
