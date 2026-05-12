/**
 * GET /api/v1/eliza/paypal/popup-callback
 *
 * Public PayPal OAuth popup-callback page.
 *
 * PayPal is configured to redirect to this URL after the user authorizes.
 * It is the registered redirect_uri (PAYPAL_REDIRECT_URI) and lives on the
 * cloud so we have one stable URL across all Agent deploys.
 *
 * This route does NOT require auth — PayPal hits it on behalf of the user
 * and we only echo the `code` + `state` back to the opener window via
 * postMessage. The opener then calls /paypal/callback with auth attached
 * to actually exchange the code.
 *
 * The HTML enforces a strict targetOrigin so no third-party site can read
 * the code by opening this URL inside an iframe. Defaults to "*" if no
 * AGENT_APP_ORIGIN is configured (acceptable for the early integration
 * window — this is a one-shot code, not a long-lived secret).
 */

import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function escapeForJsString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\x3c")
    .replace(/>/g, "\\x3e")
    .replace(/\r?\n/g, "");
}

app.get("/", (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const error = c.req.query("error") ?? "";
  const errorDescription = c.req.query("error_description") ?? "";
  const agentAppOrigin = (c.env.AGENT_APP_ORIGIN as string | undefined)?.trim();
  const targetOrigin = agentAppOrigin && agentAppOrigin.length > 0 ? agentAppOrigin : "*";

  const payload = JSON.stringify({
    type: "agent-paypal-oauth",
    code,
    state,
    error,
    errorDescription,
  });

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Linking PayPal…</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body{margin:0;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#0f1115;color:#e7eaf0;}
      .card{padding:24px 28px;border-radius:12px;background:#1a1d24;text-align:center;max-width:360px;}
      .card h1{font-size:14px;margin:0 0 8px;font-weight:600;}
      .card p{font-size:12px;margin:0;color:#a4adba;}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${error ? "PayPal authorization failed" : "PayPal connected"}</h1>
      <p>${error ? "You can close this window." : "Returning to Agent…"}</p>
    </div>
    <script>
      (function () {
        var payload = ${payload};
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, '${escapeForJsString(targetOrigin)}');
          }
        } catch (err) {
          // Cross-origin postMessage failed; user can close the window manually.
        }
        setTimeout(function () { window.close(); }, 600);
      })();
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

export default app;
