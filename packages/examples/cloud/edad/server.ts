/**
 * Standalone Bun server for the edad-chat container deployment.
 *
 * Routes:
 *   GET  /                  → public/index.html
 *   GET  /style.css, etc.   → public/* static
 *   GET  /api/config        → non-secret OAuth config (app_id, cloud_url)
 *   POST /api/auth/exchange → redeem the OAuth `code`, mint an app session
 *   POST /api/messages      → forwarded to ELIZA_CLOUD_URL via @elizaos/cloud-sdk
 *   GET  /api/history       → this user's persisted chat history
 *   GET  /health            → "ok" for ECS health probes
 *
 * Auth (the supported Eliza Cloud app-OAuth model):
 *   1. The browser sends the user to `/app-auth/authorize`; Cloud redirects back
 *      with a SINGLE-USE `code` (`eac_…`), not a durable token.
 *   2. The browser POSTs that code to /api/auth/exchange ONCE. The server
 *      redeems it server-side at `GET /api/v1/app-auth/session` (which consumes
 *      the code and returns the user's identity), then mints its OWN signed app
 *      session token (see app-session.ts) that the browser reuses thereafter.
 *   3. /api/messages validates that app session (identifying the user) and
 *      forwards upstream using the app OWNER's Cloud key (`ELIZAOS_CLOUD_API_KEY`)
 *      plus `x-app-id` + `x-affiliate-code`. Billing therefore hits the app's
 *      monetized credit pool (creator inference markup) and credits the
 *      affiliate — the owner key never leaves the server.
 *
 * (An earlier version read a `?token=` param and forwarded it as the upstream
 * bearer. Cloud never returns `token` and the redeemed code is single-use, so
 * that flow could never complete a sign-in — this is the corrected design.)
 */

import { join } from "node:path";
import { CloudApiError, ElizaCloudClient } from "@elizaos/cloud-sdk";
import { mintAppSession, verifyAppSession } from "./app-session.ts";
import { dbReady, getHistory, initDb, saveTurn, userRef } from "./db.ts";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(import.meta.dir, "public");

const CLOUD_URL = (
  process.env.ELIZA_CLOUD_URL ?? "https://elizacloud.ai"
).replace(/\/+$/, "");
const AFFILIATE_CODE = process.env.ELIZA_AFFILIATE_CODE ?? "";
const APP_ID = process.env.ELIZA_APP_ID ?? "";
// The app owner's Cloud key — used SERVER-SIDE only as the upstream bearer so
// inference bills the app's monetized credit pool. Never sent to the browser.
const OWNER_CLOUD_KEY =
  process.env.ELIZAOS_CLOUD_API_KEY ?? process.env.ELIZA_CLOUD_API_KEY ?? "";
// Secret for signing app session tokens. Defaults to the owner key so a single
// configured secret suffices; set EDAD_SESSION_SECRET to rotate independently.
const SESSION_SECRET = process.env.EDAD_SESSION_SECRET ?? OWNER_CLOUD_KEY;

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
  const msgs = (
    json as { messages?: Array<{ role?: string; content?: unknown }> }
  )?.messages;
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
  return (
    flattenContent(r?.content) || flattenContent(r?.message?.content) || ""
  );
}

async function forwardMessages(
  req: Request,
  userId: string,
): Promise<Response> {
  // Upstream bearer is the app OWNER's Cloud key (server-side only). The signed
  // app session already authenticated `userId` to this app; upstream billing
  // goes to the app's monetized credit pool via STICKY_HEADERS' x-app-id.
  const cloud = new ElizaCloudClient({
    baseUrl: CLOUD_URL,
    bearerToken: OWNER_CLOUD_KEY,
    defaultHeaders: STICKY_HEADERS,
  });

  try {
    const json = await req.json();
    const result = await cloud.routes.postApiV1Messages({ json });
    // Persist the turn to this app's isolated per-tenant DB so history survives
    // across sessions. No-op when the app has no DB (see db.ts); wrapped so a
    // persistence error never affects the reply the user gets back.
    if (dbReady()) {
      const ref = userRef(userId);
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

  // Redeem the single-use OAuth code for an app session. The code is consumed
  // server-side (so a browser reload can't burn it) and we mint our own token.
  if (
    segments.length === 2 &&
    segments[0] === "auth" &&
    segments[1] === "exchange" &&
    req.method === "POST"
  ) {
    return handleAuthExchange(req);
  }

  const userId = verifyAppSession(
    req.headers.get("x-app-session")?.trim(),
    SESSION_SECRET,
  );
  if (!userId) {
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
    return forwardMessages(req, userId);
  }

  // Signed-in user's persisted chat history from this app's per-tenant DB.
  // Empty when the app has no isolated DB — the UI just starts a fresh chat.
  if (
    segments.length === 1 &&
    segments[0] === "history" &&
    req.method === "GET"
  ) {
    const messages = dbReady() ? await getHistory(userRef(userId)) : [];
    return Response.json(
      { messages, db_enabled: dbReady() },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return jsonError(404, "not_found", "unknown route");
}

/**
 * POST /api/auth/exchange — body `{ code }`. Redeem the single-use `eac_` code
 * at Cloud's `GET /api/v1/app-auth/session` (which consumes it and returns the
 * user's identity), then mint a signed app session token for the browser.
 */
async function handleAuthExchange(req: Request): Promise<Response> {
  if (!OWNER_CLOUD_KEY || !SESSION_SECRET || !APP_ID) {
    return jsonError(
      500,
      "not_configured",
      "this app is missing its Cloud key / app id — the operator must set ELIZAOS_CLOUD_API_KEY and ELIZA_APP_ID.",
    );
  }
  let code = "";
  try {
    const body = (await req.json()) as { code?: unknown };
    code = typeof body.code === "string" ? body.code.trim() : "";
  } catch {
    return jsonError(400, "bad_request", "expected a JSON body with `code`.");
  }
  if (!code) {
    return jsonError(400, "missing_code", "no authorization code provided.");
  }
  let res: Response;
  try {
    res = await fetch(`${CLOUD_URL}/api/v1/app-auth/session`, {
      method: "GET",
      headers: { authorization: `Bearer ${code}`, "x-app-id": APP_ID },
    });
  } catch {
    return jsonError(
      502,
      "upstream_unreachable",
      "couldn't reach eliza cloud to finish sign-in. try again in a sec.",
    );
  }
  if (!res.ok) {
    return jsonError(
      401,
      "exchange_failed",
      "sign-in code was invalid or already used. try signing in again.",
    );
  }
  const session = (await res.json().catch(() => null)) as {
    user?: { id?: unknown; email?: unknown; name?: unknown };
  } | null;
  const userId =
    session && typeof session.user?.id === "string" ? session.user.id : "";
  if (!userId) {
    return jsonError(
      502,
      "exchange_failed",
      "cloud returned no user identity.",
    );
  }
  return Response.json(
    {
      session: mintAppSession(userId, SESSION_SECRET),
      user: {
        id: userId,
        email:
          typeof session?.user?.email === "string" ? session.user.email : null,
        name:
          typeof session?.user?.name === "string" ? session.user.name : null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function serveStatic(
  req: Request,
  pathname: string,
): Promise<Response | null> {
  const target = pathname === "/" ? "/index.html" : pathname;
  if (target.includes("..") || !target.startsWith("/")) return null;
  const file = Bun.file(join(PUBLIC_DIR, target));
  if (!(await file.exists())) return null;
  if (target === "/index.html") {
    const html = await file.text();
    const ogImageUrl = new URL("og-image.png", req.url).toString();
    return new Response(
      html.replaceAll('content="og-image.png"', `content="${ogImageUrl}"`),
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  }
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

    const staticRes = await serveStatic(req, url.pathname);
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
