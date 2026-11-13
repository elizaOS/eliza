/**
 * Hosted fallback pages for native (mobile) App Auth sign-in callbacks and billing returns.
 * Rendered when Android App Links do not intercept the redirect URL on the device.
 */

export interface NativeAuthCallback {
  redirectUri: string;
  androidPackage: string;
  appName: string;
}

export const NATIVE_CALLBACK_SCRUB_SCRIPT =
  '(function(){var R=/^[A-Za-z0-9_-]{43}$/,s=null;function f(t){t.split("&").forEach(function(p){var i=p.indexOf("=");if(s===null&&i>0&&p.slice(0,i)==="state"&&R.test(p.slice(i+1)))s=p.slice(i+1)})}f(location.hash.slice(1));f(location.search.slice(1));var a=document.getElementById("open");if(a&&s)a.href=a.href.replace("#Intent;","?error=app_link_unverified&state="+s+"#Intent;");if(location.hash||location.search)history.replaceState(null,"",location.pathname)})();';

export const NATIVE_CALLBACK_SCRIPT_HASH = "sha256-fNxHkHlQFHRiRhxEEUudIprPl4u12pkFQlEahycnH88=";

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function buildNativeSignInIntentUrl(url: URL, callback: NativeAuthCallback): string {
  return `intent://${url.host}${new URL(callback.redirectUri).pathname}#Intent;scheme=https;package=${callback.androidPackage};end`;
}

export function nativeSignInCallbackFallback(url: URL, callback: NativeAuthCallback): Response {
  const href = escapeHtml(buildNativeSignInIntentUrl(url, callback));
  const appName = escapeHtml(callback.appName);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Return to ${appName}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
main { max-width: 420px; text-align: center; line-height: 1.5; }
a { display: inline-block; margin-top: 16px; padding: 14px 22px; border-radius: 10px; background: #111; color: #fff; font-weight: 600; text-decoration: none; }
@media (prefers-color-scheme: dark) { a { background: #f4f4f4; color: #111; } }
</style>
</head>
<body>
<main>
<h1>Sign-in did not finish</h1>
<p>${appName} did not open automatically, so this sign-in was not completed. Return to ${appName} and start sign-in again.</p>
<p>If this keeps happening, open Android Settings, then Apps, ${appName}, Open by default, and allow it to open its supported links.</p>
<a id="open" href="${href}">Return to ${appName}</a>
<script>${NATIVE_CALLBACK_SCRUB_SCRIPT}</script>
</main>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src '${NATIVE_CALLBACK_SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

const NATIVE_AUTH_CALLBACK_SUFFIX = "/auth/callback";
const NATIVE_BILLING_RETURN_SUFFIX = "/billing/return";

export function nativeBillingReturnPath(redirectUri: string): string | null {
  const pathname = new URL(redirectUri).pathname;
  return pathname.endsWith(NATIVE_AUTH_CALLBACK_SUFFIX)
    ? `${pathname.slice(0, -NATIVE_AUTH_CALLBACK_SUFFIX.length)}${NATIVE_BILLING_RETURN_SUFFIX}`
    : null;
}

export function nativeBillingReturnFallback(url: URL, callback: NativeAuthCallback): Response {
  const path = nativeBillingReturnPath(callback.redirectUri);
  const result = url.searchParams.get("result");
  const sessionId = url.searchParams.get("session_id");
  const query = new URLSearchParams();
  if (sessionId !== null && CHECKOUT_SESSION_ID.test(sessionId)) query.set("session_id", sessionId);
  if (result === "success" || result === "cancel") query.set("result", result);
  const search = query.size > 0 ? `?${query}` : "";
  const href = escapeHtml(
    `intent://${url.host}${path}${search}#Intent;scheme=https;package=${callback.androidPackage};end`,
  );
  const appName = escapeHtml(callback.appName);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Return to ${appName}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
main { max-width: 420px; text-align: center; line-height: 1.5; }
a { display: inline-block; margin-top: 16px; padding: 14px 22px; border-radius: 10px; background: #111; color: #fff; font-weight: 600; text-decoration: none; }
@media (prefers-color-scheme: dark) { a { background: #f4f4f4; color: #111; } }
</style>
</head>
<body>
<main>
<h1>Return to ${appName}</h1>
<p>Return to ${appName} to finish.</p>
<a id="open" href="${href}">Return to ${appName}</a>
</main>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
