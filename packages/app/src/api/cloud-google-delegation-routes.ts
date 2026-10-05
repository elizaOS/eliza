/** Authenticated enrollment only: neither static API keys nor local bypass establish a Cloud user. */
import type http from "node:http";
import { getCloudRuntimeRequestIdentity } from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import { readRequestBodyBuffer } from "@elizaos/host";
import type { CloudGoogleDelegationService } from "@elizaos/plugin-elizacloud/services/cloud-google-delegation";
import { authStoreForRuntime } from "../services/auth-store";
import { resolveAuthorizedRouteRole } from "./auth";
export async function handleCloudGoogleDelegationRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: IAgentRuntime | null,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!path.startsWith("/api/workflow/hosted/cloud-delegation/")) return false;
  const send = (status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(value));
  };
  try {
    if (req.method !== "POST") {
      send(405, { error: "POST required" });
      return true;
    }
    const store = authStoreForRuntime(runtime);
    if (!runtime || !store) {
      send(503, { error: "Cloud delegation unavailable" });
      return true;
    }
    let ownerId = getCloudRuntimeRequestIdentity(req);
    if (!ownerId) {
      const auth = await resolveAuthorizedRouteRole(req, {
        store,
        allowTrustedLocalBypass: false,
      });
      if (auth.ok) ownerId = auth.identityId;
    }
    if (!ownerId) {
      send(401, { error: "A verified Cloud user session is required" });
      return true;
    }
    const identity = await store.findIdentity(ownerId);
    if (!identity || identity.kind !== "owner" || !identity.cloudUserId) {
      send(403, { error: "Connect your verified Cloud identity first" });
      return true;
    }
    const service = runtime.getService<CloudGoogleDelegationService>(
      "cloud_google_delegation",
    );
    if (!service) {
      send(503, { error: "Cloud delegation unavailable" });
      return true;
    }
    const bytes = await readRequestBodyBuffer(req, { maxBytes: 20000 });
    const body = bytes ? JSON.parse(Buffer.from(bytes).toString("utf8")) : null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      send(400, { error: "JSON object required" });
      return true;
    }
    const principal = { ownerId, cloudUserId: identity.cloudUserId };
    if (path.endsWith("/start"))
      send(200, await service.begin(principal, body));
    else if (path.endsWith("/complete"))
      send(200, await service.complete(principal, body));
    else if (path.endsWith("/status"))
      send(200, await service.status(principal, body));
    else if (path.endsWith("/cancel"))
      send(200, await service.cancel(principal, body));
    else if (path.endsWith("/revocations"))
      send(200, await service.revocations(ownerId));
    else if (path.endsWith("/revoke"))
      send(200, await service.revoke(ownerId, body));
    else send(404, { error: "Unknown delegation operation" });
  } catch (error) {
    const status =
      typeof error === "object" &&
      error &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 409;
    send(status, {
      error:
        "Cloud delegation could not complete. Review the account or reconnect.",
    });
  }
  return true;
}
