/**
 * Standalone Bun server for the edad-chat container deployment.
 *
 * Routes:
 *   GET  /                  → public/index.html
 *   GET  /style.css, etc.   → public/* static
 *   GET  /api/config        → non-secret OAuth config (app_id, cloud_url)
 *   POST /api/messages      → forwarded to ELIZA_CLOUD_URL via @elizaos/cloud-sdk
 *   GET  /health            → "ok" for ECS health probes
 *
 * Auth: the browser obtains a Steward JWT via OAuth and sends it on every
 * /api/messages call as `x-user-token`. The server forwards that as the
 * SDK's bearer token, so the upstream debits the signed-in user's org
 * credit balance — keeping the monetization story honest.
 *
 * The SDK forwards `x-app-id` and `x-affiliate-code` as default headers
 * (when configured) so upstream attributes the inference markup to the
 * app creator and the affiliate share to the affiliate code holder.
 */

import { join } from "node:path";
import { CloudApiError, ElizaCloudClient } from "@elizaos/cloud-sdk";
import { dbReady, getHistory, initDb, saveTurn, userRef } from "./db.ts";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(import.meta.dir, "public");

const CLOUD_URL = (
  process.env.ELIZA_CLOUD_URL ?? "https://www.elizacloud.ai"
).replace(/\/+$/, "");
const AFFILIATE_CODE = process.env.ELIZA_AFFILIATE_CODE ?? "";
const APP_ID = process.env.ELIZA_APP_ID ?? "";

// Sticky headers attached to every upstream call. Empty values are
// intentionally omitted: passing an unknown affiliate code makes upstream
// 500 with a raw DB error leak.
const STICKY_HEADERS: Record<string, string> = {
  ...(APP_ID ? { "x-app-id": APP_ID } : {}),
  ...(AFFILIATE_CODE ? { "x-affiliate-code": AFFILIATE_CODE } : {}),
  "anthropic-version": "2023-06-01",
};

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Flatten a message `content` (string, or an array of {text} parts) to plain
// text for persistence. Defensive: unknown shapes collapse to "".
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : typeof (c as { text?: unknown })?.text === "string"
            ? (c as { text: string }).text
            : "",
      )
      .join(" ")
      .trim();
  }
  return "";
}

/** The user's latest message text from the forwarded request body. */
function extractUserText(json: unknown): string {
  const msgs = (json as { messages?: Array<{ role?: string; content?: unknown }> })?.messages;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") return flattenContent(msgs[i]?.content);
    }
  }
  return "";
}

/** The assistant reply text from the upstream result (Anthropic-style shape). */
function extractReplyText(result: unknown): string {
  const r = result as { content?: unknown; message?: { content?: unknown } };
  return flattenContent(r?.content) || flattenContent(r?.message?.content) || "";
}

async function forwardMessages(
  req: Request,
  userToken: string,
): Promise<Response> {
  const cloud = new ElizaCloudClient({
    baseUrl: CLOUD_URL,
    bearerToken: userToken,
    defaultHeaders: STICKY_HEADERS,
  });

  try {
    const json = await req.json();
    const result = await cloud.routes.postApiV1Messages({ json });
    // Persist the turn to this app's isolated per-tenant DB so history survives
    // across sessions. No-op when the app has no DB (see db.ts); wrapped so a
    // persistence error never affects the reply the user gets back.
    if (dbReady()) {
      const ref = userRef(userToken);
      await saveTurn(ref, "user", extractUserText(json));
      await saveTurn(ref, "assistant", extractReplyText(result));
    }
    return Response.json(result);
  } catch (err) {
    if (err instanceof CloudApiError) {
      return new Response(JSON.stringify(err.errorBody), {
        status: err.statusCode,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }
    return jsonError(
      502,
      "upstream_unreachable",
      "eliza cloud didn't answer the phone. try again in a sec.",
    );
  }
}

async function handleApi(req: Request, segments: string[]): Promise<Response> {
  // Local-only config endpoint — hands the browser the non-secret OAuth
  // config it needs to start the "Sign in with Eliza Cloud" flow.
  if (segments.length === 1 && segments[0] === "config") {
    return Response.json(
      {
        app_id: APP_ID || null,
        cloud_url: CLOUD_URL,
        affiliate_code: AFFILIATE_CODE,
        db_enabled: dbReady(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const userToken = req.headers.get("x-user-token")?.trim();
  if (!userToken) {
    return jsonError(
      401,
      "not_signed_in",
      "dad needs you to sign in with eliza cloud first, champ. hit the sign-in button up top.",
    );
  }

  if (
    segments.length === 1 &&
    segments[0] === "messages" &&
    req.method === "POST"
  ) {
    return forwardMessages(req, userToken);
  }

  // Signed-in user's persisted chat history from this app's per-tenant DB.
  // Empty when the app has no isolated DB — the UI just starts a fresh chat.
  if (segments.length === 1 && segments[0] === "history" && req.method === "GET") {
    const messages = dbReady() ? await getHistory(userRef(userToken)) : [];
    return Response.json(
      { messages, db_enabled: dbReady() },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return jsonError(404, "not_found", "unknown route");
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const target = pathname === "/" ? "/index.html" : pathname;
  if (target.includes("..") || !target.startsWith("/")) return null;
  const file = Bun.file(join(PUBLIC_DIR, target));
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": "no-store" } });
}

// Connect the per-tenant DB (if any) before we start taking requests. Never
// throws — a missing/unreachable DB just means stateless mode (see db.ts).
await initDb();

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname.startsWith("/api/")) {
      const segments = url.pathname
        .slice("/api/".length)
        .split("/")
        .filter((s) => s !== "");
      if (!segments.length || segments.some((s) => s.includes(".."))) {
        return jsonError(404, "not_found", "unknown route");
      }
      return handleApi(req, segments);
    }

    const staticRes = await serveStatic(url.pathname);
    if (staticRes) return staticRes;

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `[edad-chat] listening on http://${server.hostname}:${server.port}`,
);
console.log(`[edad-chat] cloud:      ${CLOUD_URL}`);
console.log(`[edad-chat] app_id:     ${APP_ID || "(unset)"}`);
console.log(`[edad-chat] affiliate:  ${AFFILIATE_CODE || "(unset)"}`);
