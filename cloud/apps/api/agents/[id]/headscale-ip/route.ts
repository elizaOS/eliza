/**
 * GET /api/agents/:id/headscale-ip
 *
 * Internal-only endpoint consumed by the nginx Lua router.
 * Returns { headscale_ip, web_ui_port, status } so nginx can proxy_pass to
 * the correct container.
 *
 * Access is restricted with a shared internal token (HEADSCALE_INTERNAL_TOKEN)
 * injected by the trusted reverse proxy. Do not expose this endpoint publicly.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getInternalToken(c: AppContext): string | null {
  const direct = c.req.header("x-internal-token");
  if (direct) return direct.trim();
  const authorization = c.req.header("authorization");
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return null;
}

function getExpectedInternalToken(c: AppContext): string | null {
  for (const key of ["HEADSCALE_INTERNAL_TOKEN", "CONTAINER_CONTROL_PLANE_TOKEN"] as const) {
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

app.get("/", async (c) => {
  const agentId = c.req.param("id") ?? "";

  const expectedToken = getExpectedInternalToken(c);
  if (!expectedToken) {
    console.error("[headscale-ip] internal lookup token is not configured");
    return c.json({ error: "internal auth not configured" }, 503);
  }

  const providedToken = getInternalToken(c) ?? "";
  if (!constantTimeEqual(providedToken, expectedToken)) {
    console.warn(`[headscale-ip] blocked unauthorized lookup for ${agentId}`);
    return c.json({ error: "forbidden" }, 403);
  }

  if (!UUID_RE.test(agentId)) {
    return c.json({ error: "invalid agent ID format" }, 400);
  }

  try {
    const sandbox = await agentSandboxesRepository.findById(agentId);
    if (!sandbox) return c.json({ error: "agent not found" }, 404);

    let ip = sandbox.headscale_ip || null;
    if (!ip && sandbox.health_url) {
      try {
        const parsed = new URL(sandbox.health_url);
        ip = parsed.hostname;
      } catch {
        // health_url not parseable
      }
    }

    if (!ip) return c.json({ error: "agent has no routable IP" }, 503);
    const webUiPort = sandbox.web_ui_port ?? 0;
    if (!webUiPort) return c.json({ error: "agent has no web UI port" }, 503);

    return c.json({
      headscale_ip: ip,
      web_ui_port: webUiPort,
      status: sandbox.status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[headscale-ip] lookup error:", msg);
    return c.json({ error: "lookup failed" }, 500);
  }
});

export default app;
