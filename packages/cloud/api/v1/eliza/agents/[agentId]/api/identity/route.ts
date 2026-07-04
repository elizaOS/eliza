// Handles v1 cloud API v1 eliza agents agentid api identity route traffic with route-local auth expectations.
import { type Context, Hono } from "hono";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  getCurrentIdentity,
  json,
  optionsResponse,
  requireAgent,
  routeError,
  serializeIdentity,
} from "./common";

function __next_OPTIONS() {
  return optionsResponse();
}

export async function handleGetIdentity(
  c: Context<AppEnv>,
  paramsPromise: Promise<{ agentId: string }>,
): Promise<Response> {
  try {
    const { agentId } = await paramsPromise;
    const auth = await requireAgent(c, agentId);
    if ("response" in auth && auth.response) return auth.response;
    const identity = await getCurrentIdentity(
      agentId,
      auth.user.organization_id,
    );
    if (!identity)
      return json(
        { success: false, error: "Identity not found" },
        { status: 404 },
      );
    return json({ success: true, data: serializeIdentity(identity) });
  } catch (error) {
    return routeError(c, error);
  }
}

const app = new Hono<AppEnv>();
app.options("/", () => __next_OPTIONS());
app.get("/", (c) =>
  handleGetIdentity(
    c,
    nextStyleParams(c, [{ name: "agentId", splat: false }] as const).params,
  ),
);
export default app;
