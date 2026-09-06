/** Starts managed Google consent using the delegated account, without agent provisioning. */
import type { Context } from "hono";
import { z } from "zod";
import type { initiateManagedGoogleConnection } from "@/lib/services/agent-google-connector";
import {
  type OutreachrDelegationService,
  outreachrRegistration,
} from "@/lib/services/outreachr-delegation";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";

const input = z.object({}).strict();

export function createGoogleConnectHandler(deps: {
  delegation: Pick<OutreachrDelegationService, "authorize">;
  connect: typeof initiateManagedGoogleConnection;
}) {
  return async (c: Context<AppEnv>) => {
    const user = await deps.delegation.authorize(
      outreachrRegistration(c.env),
      c.req.header("X-Outreachr-Client") ?? "",
      c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
    );
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok)
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    input.parse(decoded.value);
    const result = await deps.connect({
      organizationId: user.organizationId,
      userId: user.id,
      side: "owner",
      redirectUrl: "/auth/success?platform=google",
      capabilities: [
        "google.basic_identity",
        "google.gmail.triage",
        "google.gmail.send",
        "google.calendar.read",
        "google.calendar.write",
      ],
    });
    return c.json({ success: true, authUrl: result.authUrl });
  };
}
