import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/helpers";
import { containers as containersTable } from "@/db/schemas/containers";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/apps-ingress/ask?domain=<host>
 *
 * Caddy on-demand-TLS `ask` endpoint for the apps front door. Before issuing a
 * Let's Encrypt cert for `<shortid>.apps.elizacloud.ai`, the app node's Caddy
 * calls this with the requested SNI in `?domain=`. We return **200** iff a
 * RUNNING / deploying app container owns that exact public hostname — so Caddy
 * only ever requests certs for real, live apps, and an attacker can't make it
 * spam Let's Encrypt for non-existent subdomains.
 *
 * PUBLIC + side-effect-free: it only reveals whether a given app subdomain is
 * live, which the wildcard DNS already implies. (Hardening — a per-node token /
 * IP allowlist — is tracked in #8321.) Fails CLOSED: on a lookup error we deny
 * the cert rather than authorize one we can't verify.
 */
const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (!domain) {
    return c.text("missing domain", 400);
  }
  try {
    const [row] = await dbRead
      .select({ id: containersTable.id })
      .from(containersTable)
      .where(
        and(
          eq(containersTable.public_hostname, domain),
          sql`${containersTable.status} in ('running','deploying')`,
        ),
      )
      .limit(1);
    return row ? c.text("ok", 200) : c.text("unknown app", 404);
  } catch (error) {
    logger.error("[apps-ingress/ask] lookup failed", {
      error: error instanceof Error ? error.message : String(error),
      domain,
    });
    return c.text("error", 503); // fail closed
  }
});

export default app;
