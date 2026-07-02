/**
 * Shared request guards for the `/apps/:id/domains/*` route family.
 *
 * Every domains route authenticates the caller, loads the app, and enforces
 * org ownership + app-scoped-key scope identically; the DNS routes further
 * require the domain to be attached to the app and cloudflare-managed. One
 * implementation keeps the acceptance criteria identical across list/attach/
 * detach, check, sync, status, verify and the dns record routes.
 *
 * (The buy route keeps its own guard on purpose: it parses the body before
 * the app lookup and returns 403 — not 404 — on a cross-org app.)
 */

import type { ManagedDomain } from "@/db/schemas/managed-domains";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { type App, appsService } from "@/lib/services/apps";
import { managedDomainsService } from "@/lib/services/managed-domains";
import type { AppContext } from "@/types/cloud-worker-env";

/**
 * Explicit result shapes (instead of inferred literal unions) so `"error" in
 * ctx` narrowing keeps working across the module boundary at every call site.
 */
type GuardFailure = { error: string; status: 400 | 403 | 404 | 409 };
type OwnedAppContext = {
  user: Awaited<ReturnType<typeof requireUserOrApiKeyWithOrg>>;
  app: App;
  appId: string;
};

export async function loadOwnedApp(
  c: AppContext,
): Promise<GuardFailure | OwnedAppContext> {
  const user = await requireUserOrApiKeyWithOrg(c);
  const appId = c.req.param("id");
  if (!appId) return { error: "missing path params", status: 400 as const };
  const appRow = await appsService.getById(appId);
  if (!appRow || appRow.organization_id !== user.organization_id) {
    return { error: "App not found", status: 404 as const };
  }
  if (await isAppKeyOutOfScope(c.get("apiKeyId"), appId)) {
    return { error: "Access denied", status: 403 as const };
  }
  return { user, app: appRow, appId };
}

/**
 * loadOwnedApp + the `:domain` path param resolved to the caller org's own
 * managed-domains row, gated to cloudflare-registered domains (external
 * domains are DNS-managed at the user's own provider).
 */
export async function loadCloudflareManagedDomain(
  c: AppContext,
): Promise<GuardFailure | (OwnedAppContext & { domain: ManagedDomain })> {
  const base = await loadOwnedApp(c);
  if ("error" in base) return base;

  const domainParam = c.req.param("domain");
  if (!domainParam)
    return { error: "missing path params", status: 400 as const };

  // getOwnDomainRow is already scoped to the caller's organization.
  const md = await managedDomainsService.getOwnDomainRow(
    base.user.organization_id,
    decodeURIComponent(domainParam),
  );
  if (!md || md.appId !== base.appId) {
    return { error: "Domain not attached to this app", status: 404 as const };
  }
  if (md.registrar !== "cloudflare" || !md.cloudflareZoneId) {
    return {
      error:
        "DNS records on external domains must be edited at your existing DNS provider",
      status: 409 as const,
    };
  }
  return { ...base, domain: md };
}
