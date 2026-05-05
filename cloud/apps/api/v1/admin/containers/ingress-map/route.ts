import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Admin: ingress map.
 *
 * Returns the current `host → upstream` map for all running containers.
 * Operators consume this from a reverse proxy (Caddy `import_url`,
 * Traefik file provider, Cloudflare Tunnel ingress, custom Node
 * proxy, etc.) to wire stable public hostnames to per-container
 * `node_hostname:host_port` upstreams.
 *
 * The schema is intentionally generic so the same payload feeds any
 * ingress implementation. Format options:
 *
 *   ?format=json (default) — { entries: [{ host, upstream, container }] }
 *   ?format=caddy           — Caddyfile snippet ready to `import` from a
 *                             parent Caddyfile.
 *
 * Auth: super_admin only. The endpoint exposes container hostnames +
 * node IPs which are operationally sensitive but not secrets.
 */

import { and, isNotNull, sql } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import { containers as containersTable } from "@/db/schemas/containers";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";

interface IngressEntry {
  host: string;
  upstream: string;
  containerId: string;
  containerName: string;
  organizationId: string;
  status: string;
}

async function __hono_GET(request: Request) {
  const { role } = await requireAdmin(request);
  if (role !== "super_admin") {
    return Response.json({ success: false, error: "Super admin access required" }, { status: 403 });
  }

  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";

  try {
    // Only running / deploying containers belong in the ingress map.
    // Failed and stopped containers should not receive traffic; the
    // ingress proxy returning 502 for stale rows would leak info.
    const rows = await dbRead
      .select({
        id: containersTable.id,
        name: containersTable.name,
        organization_id: containersTable.organization_id,
        status: containersTable.status,
        public_hostname: containersTable.public_hostname,
        metadata: containersTable.metadata,
      })
      .from(containersTable)
      .where(
        and(
          isNotNull(containersTable.public_hostname),
          sql`${containersTable.status} in ('running','deploying')`,
        ),
      )
      .orderBy(containersTable.public_hostname);

    const entries: IngressEntry[] = [];
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const hostname = typeof meta.hostname === "string" ? meta.hostname : null;
      const hostPort = typeof meta.hostPort === "number" ? meta.hostPort : null;
      if (!row.public_hostname || !hostname || !hostPort) continue;
      entries.push({
        host: row.public_hostname,
        upstream: `http://${hostname}:${hostPort}`,
        containerId: row.id,
        containerName: row.name,
        organizationId: row.organization_id,
        status: row.status,
      });
    }

    if (format === "caddy") {
      const body = entries
        .map(
          (e) => `${e.host} {\n  reverse_proxy ${e.upstream}\n  log {\n    output stdout\n  }\n}`,
        )
        .join("\n\n");
      return new Response(`${body}\n`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return Response.json({
      success: true,
      data: { entries, generatedAt: new Date().toISOString() },
    });
  } catch (error) {
    logger.error("[admin/containers/ingress-map] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to read ingress map",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
export default __hono_app;
