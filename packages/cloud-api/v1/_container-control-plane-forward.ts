import { logger } from "@/lib/utils/logger";
import type { AppContext, AuthedUser } from "@/types/cloud-worker-env";

const CONTROL_PLANE_URL_KEYS = [
  "CONTAINER_CONTROL_PLANE_URL",
  "CONTAINER_SIDECAR_URL",
  "HETZNER_CONTAINER_CONTROL_PLANE_URL",
] as const;

function readStringEnv(c: AppContext, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = c.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function forwardControlPlaneRequest(
  c: AppContext,
  configureHeaders: (headers: Headers) => void,
): Promise<Response> {
  const baseUrl = readStringEnv(c, CONTROL_PLANE_URL_KEYS);
  if (!baseUrl) {
    return c.json(
      {
        success: false,
        code: "CONTAINER_CONTROL_PLANE_NOT_CONFIGURED",
        error: "Container control plane URL is not configured",
      },
      503,
    );
  }

  const sourceUrl = new URL(c.req.url);
  const target = new URL(baseUrl);
  target.pathname = sourceUrl.pathname;
  target.search = sourceUrl.search;

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", sourceUrl.host);
  headers.set("x-forwarded-proto", sourceUrl.protocol.replace(":", ""));

  const internalToken = readStringEnv(c, ["CONTAINER_CONTROL_PLANE_TOKEN"]);
  if (internalToken) headers.set("x-container-control-plane-token", internalToken);

  const databaseUrl = readStringEnv(c, ["DATABASE_URL"]);
  if (databaseUrl) headers.set("x-eliza-cloud-database-url", databaseUrl);

  configureHeaders(headers);

  try {
    const upstream = await fetch(target, {
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      headers,
      method: c.req.method,
      redirect: "manual",
    });

    return new Response(upstream.body, {
      headers: upstream.headers,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    logger.error("[ContainerControlPlane] forward failed", {
      target: target.origin,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      {
        success: false,
        code: "CONTAINER_CONTROL_PLANE_UNREACHABLE",
        error: "Container control plane is unreachable",
      },
      503,
    );
  }
}

export async function forwardToContainerControlPlane(
  c: AppContext,
  user: Pick<AuthedUser, "id"> & { organization_id: string },
): Promise<Response> {
  return forwardControlPlaneRequest(c, (headers) => {
    headers.set("x-eliza-user-id", user.id);
    headers.set("x-eliza-organization-id", user.organization_id);
  });
}

export async function forwardCronToContainerControlPlane(c: AppContext): Promise<Response> {
  return forwardControlPlaneRequest(c, () => {});
}
