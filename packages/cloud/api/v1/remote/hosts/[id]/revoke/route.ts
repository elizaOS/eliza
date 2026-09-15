/**
 * Revokes an owner-scoped host and drains a bounded page of relay authority.
 * Revocation and pending Headscale cleanup are recovery operations and remain
 * available while new paid/external work is fenced by account standing.
 */

import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseRemoteHostCredential } from "../../../host-auth";
import {
  cleanupManagedNetwork,
  managedNetworkConfig,
} from "../../../managed-network";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const id = c.req.param("id")?.trim() ?? "";
    if (!isRemotePairingUuid(id)) {
      return c.json({ success: false, error: "Host id must be a UUID" }, 400);
    }
    const credential = parseRemoteHostCredential(c.req.raw);
    let result: Awaited<ReturnType<typeof remoteHostsRepository.revoke>>;
    if (credential) {
      result =
        credential.hostId === id
          ? await remoteHostsRepository.revokeAuthenticated(
              id,
              credential.token,
            )
          : undefined;
    } else {
      const user = await requireUserOrApiKeyWithOrg(c);
      result = await remoteHostsRepository.revoke(
        id,
        user.organization_id,
        user.id,
      );
    }
    if (!result)
      return c.json({ success: false, error: "Host not found" }, 404);
    if (!result.cleanup.more && result.host.headscale_cleanup_pending) {
      const config = managedNetworkConfig(
        c.env as unknown as Record<string, unknown>,
      );
      if (!config) {
        await remoteHostsRepository.recordManagedCleanupFailure({
          hostId: result.host.id,
          organizationId: result.host.organization_id,
          userId: result.host.user_id,
          message: "Headscale cleanup configuration is unavailable.",
        });
        throw new Error(
          "Managed-network cleanup is waiting for Headscale configuration.",
        );
      }
      await cleanupManagedNetwork({
        host: result.host,
        organizationId: result.host.organization_id,
        userId: result.host.user_id,
        config,
        repository: remoteHostsRepository,
      });
    }
    return c.json({
      success: true,
      data: {
        id: result.host.id,
        status: result.host.status,
        alreadyRevoked: result.alreadyRevoked,
        cleanup: result.cleanup,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
