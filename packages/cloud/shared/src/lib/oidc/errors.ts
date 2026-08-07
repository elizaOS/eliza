/**
 * Error shapes for the OIDC endpoints, and the one decision that matters most
 * at `/authorize`: whether a failure may be redirected at all.
 *
 * An error may only travel to `redirect_uri` AFTER the client is known and the
 * redirect URI has been exact-matched against its registry entry. Before that,
 * the request has not proven where it came from, and redirecting would turn a
 * trusted host into an open redirector. `renderOidcErrorPage` is what those
 * pre-validation failures return instead — a plain, fully escaped HTML page
 * served from this origin.
 */

import { escapeHtml } from "../utils/html";

export type OidcErrorCode =
  // RFC 6749 4.1.2.1 and OpenID Connect Core 3.1.2.6 — authorization response.
  | "invalid_request"
  | "unauthorized_client"
  | "access_denied"
  | "unsupported_response_type"
  | "invalid_scope"
  | "server_error"
  | "temporarily_unavailable"
  | "login_required"
  | "consent_required"
  | "account_selection_required"
  // RFC 6749 5.2 — token response.
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  // RFC 6750 3.1 — bearer-token-protected resource.
  | "invalid_token"
  | "insufficient_scope";

/**
 * RFC 6749 5.2 enumerates the token-endpoint error codes and that set is
 * CLOSED. The authorization-response codes are NOT in it — a relying party
 * matching a token error against the 5.2 list treats `temporarily_unavailable`
 * or `server_error` as an unrecognized, permanent failure and gives up on a
 * login that would have succeeded on retry. This type is the enforcement:
 * `oidcTokenErrorBody` is the only way the token route builds a protocol error,
 * so a code outside the set cannot be emitted by accident.
 */
export type OidcTokenErrorCode = Extract<
  OidcErrorCode,
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
>;

export interface OidcErrorBody {
  error: OidcErrorCode;
  error_description: string;
}

export function oidcErrorBody(error: OidcErrorCode, description: string): OidcErrorBody {
  return { error, error_description: description };
}

/** An RFC 6749 5.2 token error response, restricted to that section's set. */
export function oidcTokenErrorBody(error: OidcTokenErrorCode, description: string): OidcErrorBody {
  return { error, error_description: description };
}

/**
 * Build the `redirect_uri?error=…&state=…` target. Only ever called with a
 * redirect URI that already matched the client registry exactly.
 */
export function buildOidcErrorRedirect(
  redirectUri: string,
  error: OidcErrorCode,
  description: string,
  state: string | null,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Terminal error page for a request that must not be redirected. Inline-styled
 * on purpose: it renders before any application shell exists, so it must not
 * depend on an asset load that could itself fail.
 */
export function renderOidcErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:3rem 1.5rem;background:#0b0b0d;color:#f4f4f5;font:16px/1.6 ui-sans-serif,system-ui,sans-serif">
<main style="max-width:34rem;margin:0 auto">
<h1 style="font-size:1.25rem;margin:0 0 .75rem">${escapeHtml(title)}</h1>
<p style="margin:0;color:#a1a1aa">${escapeHtml(detail)}</p>
</main>
</body>
</html>`;
}
