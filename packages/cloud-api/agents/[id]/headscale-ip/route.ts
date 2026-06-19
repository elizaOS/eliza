/**
 * GET /api/agents/:id/headscale-ip
 *
 * Internal-only endpoint consumed by the nginx Lua router.
 * Returns { headscale_ip, web_ui_port, status } so nginx can proxy_pass to
 * the correct container. This route deliberately does not fall back to
 * health_url / bridge_url hostnames: the reverse proxy needs the persisted
 * Headscale route, not public Docker host + dynamic port metadata.
 *
 * Access is restricted with a shared internal token (HEADSCALE_INTERNAL_TOKEN)
 * injected by the trusted reverse proxy. Do not expose this endpoint publicly.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getInternalToken(c: AppContext): string | null {
  const direct = c.req.header("x-internal-token");
  if (direct) return direct.trim();
  const authorization = c.req.header("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return null;
}

function getExpectedInternalToken(c: AppContext): string | null {
  for (const key of [
    "HEADSCALE_INTERNAL_TOKEN",
    "CONTAINER_CONTROL_PLANE_TOKEN",
  ] as const) {
    const value = ((c.env[key] as string | undefined) ?? "").trim();
    if (value) return value;
  }
  return null;
}

/**
 * Constant-time string comparison. Workers has no `node:crypto.timingSafeEqual`
 * but we can fall back to a length-equal XOR loop using TextEncoder bytes —
 * sufficient for tokens that are bounded in length and fit in a single CPU
 * cache line.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

const app = new Hono<AppEnv>();

export interface HeadscaleLookupSandbox {
  status: string;
  headscale_ip?: string | null;
  web_ui_port?: number | null;
}

export function resolveHeadscaleLookupPayload(sandbox: HeadscaleLookupSandbox):
  | {
      ok: true;
      payload: {
        headscale_ip: string;
        web_ui_port: number;
        status: string;
      };
    }
  | { ok: false; status: 503; error: string } {
  const ip = sandbox.headscale_ip?.trim() || null;
  if (!ip) {
    return {
      ok: false,
      status: 503,
      error: "agent has no routable Headscale IP",
    };
  }

  const webUiPort = sandbox.web_ui_port ?? 0;
  if (!webUiPort) {
    return { ok: false, status: 503, error: "agent has no web UI port" };
  }

  return {
    ok: true,
    payload: {
      headscale_ip: ip,
      web_ui_port: webUiPort,
      status: sandbox.status,
    },
  };
}

app.get("/", async (c) => {
  const agentId = c.req.param("id") ?? "";

  const expectedToken = getExpectedInternalToken(c);
  if (!expectedToken) {
    logger.error("[headscale-ip] internal lookup token is not configured");
    return c.json({ error: "internal auth not configured" }, 503);
  }

  const providedToken = getInternalToken(c) ?? "";
  if (!constantTimeEqual(providedToken, expectedToken)) {
    logger.warn("[headscale-ip] blocked unauthorized lookup", { agentId });
    return c.json({ error: "forbidden" }, 403);
  }

  if (!UUID_RE.test(agentId)) {
    return c.json({ error: "invalid agent ID format" }, 400);
  }

  try {
    const sandbox = await agentSandboxesRepository.findById(agentId);
    if (!sandbox) return c.json({ error: "agent not found" }, 404);

    const resolved = resolveHeadscaleLookupPayload(sandbox);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    return c.json(resolved.payload);
  } catch (err) {
    logger.error("[headscale-ip] lookup error", { error: err });
    return c.json({ error: "lookup failed" }, 500);
  }
});

export default app;
