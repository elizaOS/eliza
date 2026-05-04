import { Hono } from "hono";

import { fetchHonoRoot } from "@/lib/api/hono-root-request";
import type { AppEnv } from "@/types/cloud-worker-env";

const PLATFORM_MESSAGES: Record<string, string> = {
  discord: "head back to Discord and send me a message.",
  telegram: "head back to Telegram and send me a message.",
  imessage: "head back to iMessage and send me a message.",
  web: "close this tab. your chat is ready.",
};

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  twitter: "X",
  github: "GitHub",
  slack: "Slack",
};

function buildHtml(platform: string): string {
  const instruction = PLATFORM_MESSAGES[platform] ?? PLATFORM_MESSAGES.web;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>connected</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #0d0d0d;
      color: #f5f5f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      width: min(420px, 100%);
      text-align: center;
    }
    .check {
      width: 64px;
      height: 64px;
      border-radius: 999px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 88, 0, 0.15);
      color: #ff5800;
      font-size: 32px;
      line-height: 1;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      font-weight: 600;
    }
    p {
      margin: 0;
      color: #b5b5b5;
      line-height: 1.6;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>you're connected.</h1>
    <p>${instruction}</p>
  </div>
</body>
</html>`;
}

function buildElizaAppHtml(provider: string, connectionId: string | null): string {
  const providerLabel = PROVIDER_LABELS[provider] ?? "Your account";
  const payload = JSON.stringify({
    type: "eliza-app-oauth-complete",
    provider,
    connectionId,
    connected: true,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${providerLabel} connected</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: radial-gradient(circle at top, #1c2837, #0d0d0d 60%);
      color: #f5f5f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      width: min(440px, 100%);
      text-align: center;
      padding: 32px 28px;
      border-radius: 28px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(12px);
    }
    .check {
      width: 64px;
      height: 64px;
      border-radius: 999px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(52, 199, 89, 0.14);
      color: #34c759;
      font-size: 32px;
      line-height: 1;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      font-weight: 600;
    }
    p {
      margin: 0;
      color: #b5b5b5;
      line-height: 1.6;
      font-size: 16px;
    }
    button {
      margin-top: 24px;
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      cursor: pointer;
      font: inherit;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>${providerLabel} connected.</h1>
    <p>You can return to Eliza App now. If this window does not close automatically, close it manually.</p>
    <button type="button" onclick="window.close()">Close Window</button>
  </div>
  <script>
    (function () {
      const payload = ${payload};
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(payload, "*");
          setTimeout(function () {
            window.close();
          }, 150);
        } catch (_) {
          // Best-effort only. The button remains available.
        }
      }
    })();
  </script>
</body>
</html>`;
}

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  const source = c.req.query("source");
  if (source === "eliza-app") {
    const provider = c.req.query("platform") || "connection";
    const connectionId = c.req.query("connection_id") ?? null;
    return c.body(buildElizaAppHtml(provider, connectionId), 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  const platform = c.req.query("platform") || "web";
  if (platform === "web") {
    return c.redirect(new URL("/dashboard/chat", c.req.url).toString());
  }

  return c.body(buildHtml(platform), 200, { "Content-Type": "text/html; charset=utf-8" });
});

export default app;

export const GET = (request: Request) => fetchHonoRoot(app, request);
