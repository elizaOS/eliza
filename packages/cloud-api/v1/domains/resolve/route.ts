/**
 * GET /api/v1/domains/resolve?domain=:domain
 *
 * Public host-resolution endpoint for app hosts. It returns the app attached
 * to an active, verified managed domain so the static app host can route
 * custom domains without embedding cloud database credentials.
 */

import { Hono } from "hono";
import { z } from "zod";
import { appsService } from "@/lib/services/apps";
import { managedDomainsService } from "@/lib/services/managed-domains";
import type { AppEnv } from "@/types/cloud-worker-env";

const ResolveSchema = z.object({
  domain: z
    .string()
    .min(4)
    .max(253)
    .transform((d) => d.toLowerCase().trim().replace(/\.$/, "")),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const parsed = ResolveSchema.safeParse({
    domain: c.req.query("domain") ?? c.req.header("host") ?? "",
  });
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid domain" }, 400);
  }

  const domain = parsed.data.domain;
  const managedDomain = await managedDomainsService.getDomainByName(domain);
  if (
    !managedDomain ||
    !managedDomain.appId ||
    !managedDomain.verified ||
    managedDomain.status !== "active"
  ) {
    return c.json({ success: false, error: "Domain not mapped" }, 404);
  }

  const appRow = await appsService.getById(managedDomain.appId);
  if (!appRow || !appRow.is_active || !appRow.is_approved) {
    return c.json({ success: false, error: "Mapped app is not active" }, 404);
  }

  return c.json({
    success: true,
    domain,
    app: {
      id: appRow.id,
      name: appRow.name,
      slug: appRow.slug,
      appUrl: appRow.app_url,
    },
  });
});

export default app;
