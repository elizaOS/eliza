import { Hono } from "hono";
import { agentGoogleRouteDeps } from "@/lib/services/agent-google-route-deps";
import type { AppEnv } from "@/types/cloud-worker-env";

async function __hono_GET(request: Request) {
  try {
    const { user } = await agentGoogleRouteDeps.requireAuthOrApiKeyWithOrg(request);
    const searchParams = new URL(request.url).searchParams;
    const rawSide = searchParams.get("side");
    const grantId = searchParams.get("grantId")?.trim() || undefined;
    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return Response.json({ error: "side must be owner or agent." }, { status: 400 });
    }

    return Response.json(
      await agentGoogleRouteDeps.listManagedGoogleCalendars({
        organizationId: user.organization_id,
        userId: user.id,
        side: rawSide === "agent" ? "agent" : "owner",
        grantId,
      }),
    );
  } catch (error) {
    if (error instanceof agentGoogleRouteDeps.AgentGoogleConnectorError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to list Google calendars.",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
export default __hono_app;

export { __hono_GET as GET };
