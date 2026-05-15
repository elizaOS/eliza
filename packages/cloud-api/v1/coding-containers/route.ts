import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  buildCodingContainerCreatePayload,
  buildCodingContainerSessionResponse,
  type CodingContainerCreatePayload,
  type RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerRequestSchema,
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

function validationError(c: AppContext, message: string): Response {
  return c.json({ success: false, error: message }, 400);
}

async function forwardContainerCreate(
  c: AppContext,
  user: Pick<AuthedUser, "id"> & { organization_id: string },
  request: RequestCodingAgentContainerRequest,
  payload: CodingContainerCreatePayload,
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
  target.pathname = "/api/v1/containers";
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
      body: JSON.stringify(payload),
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
            error: "Container control plane rejected the coding-container request",
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
    return c.json(
      {
        success: true,
        data: buildCodingContainerSessionResponse({
          request,
          createPayload: payload,
          upstreamData:
            body.data && typeof body.data === "object"
              ? (body.data as Record<string, unknown>)
              : body,
        }),
        controlPlane: {
          status: upstream.status,
          polling: body.polling && typeof body.polling === "object" ? body.polling : undefined,
        },
      },
      201,
    );
  } catch (error) {
    logger.error("[CodingContainers API] control-plane forward failed", {
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
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = RequestCodingAgentContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues[0]?.message ?? "Invalid coding container request",
      );
    }

    const createPayload = buildCodingContainerCreatePayload(parsed.data);
    return forwardContainerCreate(c, user, parsed.data, createPayload);
  } catch (error) {
    logger.error("[CodingContainers API] request error:", error);
    return failureResponse(c, error);
  }
});

export default app;
