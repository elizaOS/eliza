/**
 * Activates a pending managed host only after exact Headscale node discovery.
 * The host presents its one-use signed delegated enrollment credential, so the
 * route must not add a second account-cache read after owner-side admission.
 */

import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseRemoteHostCredential } from "../../../../host-auth";
import {
  activateManagedNetwork,
  managedNetworkConfig,
} from "../../../../managed-network";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const id = c.req.param("id")?.trim() ?? "";
    if (!isRemotePairingUuid(id)) {
      return c.json({ success: false, error: "Host id must be a UUID" }, 400);
    }
    const credential = parseRemoteHostCredential(c.req.raw);
    if (!credential || credential.hostId !== id) {
      return c.json({ success: false, error: "Host not found" }, 404);
    }
    const host = await remoteHostsRepository.authenticateManagedEnrollment(
      id,
      credential.token,
    );
    if (!host) {
      return c.json({ success: false, error: "Host not found" }, 404);
    }
    const config = managedNetworkConfig(
      c.env as unknown as Record<string, unknown>,
    );
    if (!config) {
      return c.json(
        {
          success: false,
          error: "Managed-network enrollment is not configured.",
          code: "MANAGED_NETWORK_UNAVAILABLE",
        },
        503,
      );
    }
    const activated = await activateManagedNetwork({
      host,
      organizationId: host.organization_id,
      userId: host.user_id,
      config,
      repository: remoteHostsRepository,
    });
    if (!activated) {
      return c.json(
        {
          success: false,
          error: "The managed-network node has not joined yet.",
          code: "MANAGED_NETWORK_NOT_CONNECTED",
        },
        409,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: { hostId: host.id, status: "active", ...activated },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
