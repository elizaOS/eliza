import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  buildCodingSyncResponse,
  type SyncCloudCodingContainerRequest,
  SyncCloudCodingContainerRequestSchema,
  type SyncCloudCodingContainerResponse,
} from "@/lib/services/coding-containers";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv, AuthedUser } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const CONTROL_PLANE_URL_KEYS = [
  "CONTAINER_CONTROL_PLANE_URL",
  "CONTAINER_SIDECAR_URL",
  "HETZNER_CONTAINER_CONTROL_PLANE_URL",
] as const;

function readStringEnv(c: AppContext, keys: readonly string[]): string | null {
  const env = c.env ?? {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function forwardContainerSync(
  c: AppContext,
  user: Pick<AuthedUser, "id"> & { organization_id: string },
  containerId: string,
  request: SyncCloudCodingContainerRequest,
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

  const target = new URL(baseUrl);
  target.pathname = `/api/v1/containers/${encodeURIComponent(containerId)}/workspace-sync`;
  target.search = "";

  const sourceUrl = new URL(c.req.url);
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("x-forwarded-host", sourceUrl.host);
  headers.set("x-forwarded-proto", sourceUrl.protocol.replace(":", ""));
  headers.set("x-eliza-user-id", user.id);
  headers.set("x-eliza-organization-id", user.organization_id);

  const internalToken = readStringEnv(c, ["CONTAINER_CONTROL_PLANE_TOKEN"]);
  if (internalToken) headers.set("x-container-control-plane-token", internalToken);

  const databaseUrl = readStringEnv(c, ["DATABASE_URL"]);
  if (databaseUrl) headers.set("x-eliza-cloud-database-url", databaseUrl);

  try {
    const upstream = await fetch(target, {
      body: JSON.stringify(request),
      headers,
      method: "POST",
      redirect: "manual",
    });
    const text = await upstream.text();
    let json: unknown = null;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!upstream.ok) {
      return new Response(
        text ||
          JSON.stringify({
            success: false,
            error: "Container control plane rejected the coding-container sync request",
          }),
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          },
        },
      );
    }

    const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const upstreamData =
      body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
    const base = buildCodingSyncResponse(containerId, request);
    const response: SyncCloudCodingContainerResponse = {
      success: true,
      data: {
        ...base,
        ...upstreamData,
        syncId: base.syncId,
        containerId,
        createdAt: base.createdAt,
        metadata: {
          ...(base.metadata ?? {}),
          ...((upstreamData.metadata as Record<string, unknown> | undefined) ?? {}),
        },
      },
      message: "Sync request applied by the container control plane.",
    };
    return c.json(response, 202);
  } catch (error) {
    logger.error("[CodingContainers API] sync forward failed", {
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

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const containerId = c.req.param("containerId");
    if (!containerId) {
      return c.json({ success: false, error: "Container id required" }, 400);
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = SyncCloudCodingContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid sync request",
        },
        400,
      );
    }

    return forwardContainerSync(c, user, decodeURIComponent(containerId), parsed.data);
  } catch (error) {
    logger.error("[CodingContainers API] sync error:", error);
    return failureResponse(c, error);
  }
});

export default app;
