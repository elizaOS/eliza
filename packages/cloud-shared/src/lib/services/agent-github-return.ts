import type { ManagedAgentGithubMode } from "./eliza-agent-config";

export const LIFEOPS_GITHUB_POST_MESSAGE_TYPE = "agent-lifeops-github-complete";

export interface LifeOpsGithubReturnDetail {
  target: "owner" | "agent";
  status: "connected" | "error";
  connectionId?: string | null;
  agentId?: string | null;
  githubUsername?: string | null;
  bindingMode?: ManagedAgentGithubMode | null;
  message?: string | null;
  restarted?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function readAgentDeepLinkPath(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "agent:") {
      return null;
    }
    const path = (parsed.pathname || parsed.host || "").replace(/^\/+/, "");
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export function resolveAgentReturnUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const path = readAgentDeepLinkPath(trimmed);
  if (!path) {
    return null;
  }
  if (path !== "lifeops" && path !== "settings") {
    return null;
  }
  return trimmed;
}

export function appendLifeOpsGithubDetailToReturnUrl(
  returnUrl: string | null,
  detail: LifeOpsGithubReturnDetail,
): string | null {
  if (!returnUrl) {
    return null;
  }
  const next = new URL(returnUrl);
  next.searchParams.set("github_target", detail.target);
  next.searchParams.set("github_status", detail.status);
  if (detail.connectionId) {
    next.searchParams.set("connection_id", detail.connectionId);
  }
  if (detail.agentId) {
    next.searchParams.set("agent_id", detail.agentId);
  }
  if (detail.githubUsername) {
    next.searchParams.set("github_username", detail.githubUsername);
  }
  if (detail.bindingMode) {
    next.searchParams.set("binding_mode", detail.bindingMode);
  }
  if (detail.message) {
    next.searchParams.set("message", detail.message);
  }
  if (detail.restarted) {
    next.searchParams.set("restarted", "1");
  }
  return next.toString();
}

export function createLifeOpsGithubReturnResponse(args: {
  title: string;
  message: string;
  detail: LifeOpsGithubReturnDetail;
  postMessage?: boolean;
  returnUrl?: string | null;
}): Response {
  const payload = {
    type: LIFEOPS_GITHUB_POST_MESSAGE_TYPE,
    target: args.detail.target,
    status: args.detail.status,
    connectionId: args.detail.connectionId ?? null,
    agentId: args.detail.agentId ?? null,
    githubUsername: args.detail.githubUsername ?? null,
    bindingMode: args.detail.bindingMode ?? null,
    message: args.detail.message ?? null,
    restarted: args.detail.restarted === true,
  };
  const deepLink = appendLifeOpsGithubDetailToReturnUrl(
    resolveAgentReturnUrl(args.returnUrl),
    args.detail,
  );

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(args.title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top, #17212f, #0a0d12 60%);
        color: #f5f7fb;
        font-family: "IBM Plex Sans", "Helvetica Neue", sans-serif;
      }
      main {
        width: min(32rem, calc(100vw - 2rem));
        padding: 2rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 1.5rem;
        background: rgba(8, 12, 18, 0.9);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.3rem;
      }
      p {
        margin: 0;
        line-height: 1.6;
        color: rgba(245, 247, 251, 0.78);
      }
      .actions {
        margin-top: 1.25rem;
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      a, button {
        border: 0;
        border-radius: 999px;
        padding: 0.75rem 1rem;
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        text-decoration: none;
        cursor: pointer;
        font: inherit;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(args.title)}</h1>
      <p>${escapeHtml(args.message)}</p>
      <div class="actions">
        ${deepLink ? `<a href="${escapeHtml(deepLink)}">Open Agent</a>` : ""}
        <button type="button" onclick="window.close()">Close Window</button>
      </div>
    </main>
    <script>
      (() => {
        const payload = ${serializeInlineScriptValue(payload)};
        const postMessageToOpener = ${args.postMessage === true ? "true" : "false"};
        const deepLink = ${serializeInlineScriptValue(deepLink)};
        if (postMessageToOpener && window.opener && !window.opener.closed) {
          try {
            window.opener.postMessage(payload, "*");
          } catch {}
        }
        if (typeof deepLink === "string" && deepLink.length > 0) {
          window.setTimeout(() => {
            try {
              window.location.replace(deepLink);
            } catch {}
          }, 60);
          return;
        }
        if (postMessageToOpener && window.opener && !window.opener.closed) {
          window.setTimeout(() => {
            try {
              window.close();
            } catch {}
          }, 180);
        }
      })();
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
