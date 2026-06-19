import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/helpers";
import { containers as containersTable } from "@/db/schemas/containers";
import { appsService } from "@/lib/services/apps";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/apps-ingress/ask?domain=<host>
 *
 * Caddy on-demand-TLS `ask` endpoint for the apps front door. Before issuing a
 * Let's Encrypt cert for a host, the app node's Caddy calls this with the
 * requested SNI in `?domain=`. We return **200** iff that host is one of:
 *   1. the system `<shortid>.apps.elizacloud.ai` host of a RUNNING / deploying
 *      app container (exact `containers.public_hostname` match), or
 *   2. a user's own **verified, active custom domain** bound to an active,
 *      approved app (e.g. `elocute.fun`) — mirroring the reviewed predicate in
 *      `/api/v1/domains/resolve`. DNS-TXT verification is the ownership proof, so
 *      an attacker can't authorize a cert for a domain they don't control.
 * Anything else 404s, so Caddy never spams Let's Encrypt for hosts we don't own.
 *
 * PUBLIC + side-effect-free: it only reveals whether a given host maps to a live
 * app, which the DNS already implies. (Hardening — a per-node token / IP
 * allowlist — is tracked in #8321.) Fails CLOSED: on a lookup error we deny the
 * cert rather than authorize one we can't verify.
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
    if (row) return c.text("ok", 200);

    // Not a system <shortid>.<base> host — authorize a cert only for a verified,
    // active custom domain bound to an active+approved app (the /domains/resolve
    // predicate). The container's liveness is enforced separately by the route
    // existing: no route -> 502 (a transient error, never a cert-abuse vector).
    const managed = await managedDomainsService.getDomainByName(domain);
    if (managed?.appId && managed.verified && managed.status === "active") {
      const appRow = await appsService.getById(managed.appId);
      if (appRow?.is_active && appRow.is_approved) {
        return c.text("ok", 200);
      }
    }
    return c.text("unknown app", 404);
  } catch (error) {
    logger.error("[apps-ingress/ask] lookup failed", {
      error: error instanceof Error ? error.message : String(error),
      domain,
    });
    return c.text("error", 503); // fail closed
  }
});

export default app;
