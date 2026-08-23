/** Enrolls and lists authenticated-owner remote runtime hosts. */

import {
  isRemoteTargetPublicIdentity,
  REMOTE_CONTROL_PROTOCOL_VERSION,
} from "@elizaos/shared/contracts/remote-control";
import { Hono } from "hono";
import {
  generateRemoteHostToken,
  hashRemoteHostToken,
} from "@/db/crypto/remote-host-token";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import { enrollManagedNetwork, managedNetworkConfig } from "../managed-network";
import { isRemoteControlIdentifier } from "../validation";

const app = new Hono<AppEnv>();
const REMOTE_HOST_ONLINE_WINDOW_MS = 15_000;

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const hosts = await remoteHostsRepository.listOwned(
      user.organization_id,
      user.id,
    );
    return c.json({
      success: true,
      data: {
        ownerId: user.id,
        hosts: hosts
          .filter((host) => host.status !== "pending")
          .map((host) => ({
            id: host.id,
            deviceId: host.device_id,
            displayName: host.display_name,
            platform: host.platform,
            connectionMode: host.connection_mode,
            runtimeKeyId: host.runtime_key_id,
            signingPublicKeyJwk: host.signing_public_jwk,
            encryptionPublicKeyJwk: host.encryption_public_jwk,
            status:
              host.status === "revoked"
                ? "revoked"
                : host.last_seen_at &&
                    Date.now() - host.last_seen_at.getTime() <=
                      REMOTE_HOST_ONLINE_WINDOW_MS
                  ? "active"
                  : "offline",
            lastSeenAt: host.last_seen_at,
            createdAt: host.created_at,
            revokedAt: host.revoked_at,
          })),
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      // error-policy:J3 malformed request JSON is an explicit client error.
      return c.json(
        { success: false, error: "Request body must be valid JSON" },
        400,
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return c.json(
        { success: false, error: "Request body must be a JSON object" },
        400,
      );
    }
    const body = value as Record<string, unknown>;
    const connectionMode = body.connectionMode ?? "relay";
    if (
      body.managedNetwork !== undefined &&
      typeof body.managedNetwork !== "boolean"
    ) {
      return c.json(
        { success: false, error: "Managed network must be a boolean" },
        400,
      );
    }
    const managedNetworkRequested = body.managedNetwork === true;
    const recoveryHostId =
      typeof body.recoveryHostId === "string" ? body.recoveryHostId.trim() : "";
    if (recoveryHostId && !isRemotePairingUuid(recoveryHostId)) {
      return c.json(
        { success: false, error: "Recovery host id must be a UUID" },
        400,
      );
    }
    if (recoveryHostId && managedNetworkRequested) {
      return c.json(
        {
          success: false,
          error:
            "Recover the host credential first; managed-network enrollment is one-use.",
        },
        409,
      );
    }
    let networkConfig = null;
    if (managedNetworkRequested) {
      try {
        networkConfig = managedNetworkConfig(
          c.env as unknown as Record<string, unknown>,
        );
      } catch (cause) {
        return c.json(
          {
            success: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Managed network is unavailable",
          },
          503,
        );
      }
      if (!networkConfig) {
        return c.json(
          {
            success: false,
            error: "Managed-network enrollment is not configured.",
          },
          503,
        );
      }
    }
    const hostId = recoveryHostId || crypto.randomUUID();
    const identity = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      role: "target",
      ownerId: user.id,
      runtimeId: hostId,
      keyId: body.runtimeKeyId,
      displayName: body.displayName,
      platform: body.platform,
      signingPublicKeyJwk: body.signingPublicKeyJwk,
      encryptionPublicKeyJwk: body.encryptionPublicKeyJwk,
      createdAt: Date.now(),
    };
    if (
      !isRemoteControlIdentifier(body.deviceId) ||
      connectionMode !== "relay" ||
      !isRemoteTargetPublicIdentity(identity)
    ) {
      return c.json(
        { success: false, error: "Remote host identity is invalid" },
        400,
      );
    }

    const token = generateRemoteHostToken();
    const hostTokenHash = await hashRemoteHostToken(token);
    const result = recoveryHostId
      ? await remoteHostsRepository.recoverCredential({
          hostId,
          organizationId: user.organization_id,
          userId: user.id,
          deviceId: body.deviceId as string,
          displayName: identity.displayName,
          platform: identity.platform,
          connectionMode: connectionMode as string,
          runtimeKeyId: identity.keyId,
          signingPublicJwk: identity.signingPublicKeyJwk,
          encryptionPublicJwk: identity.encryptionPublicKeyJwk,
          hostTokenHash,
        })
      : await remoteHostsRepository.createOwned({
          id: hostId,
          organization_id: user.organization_id,
          user_id: user.id,
          device_id: body.deviceId,
          display_name: identity.displayName,
          platform: identity.platform,
          connection_mode: connectionMode,
          runtime_key_id: identity.keyId,
          signing_public_jwk: identity.signingPublicKeyJwk,
          encryption_public_jwk: identity.encryptionPublicKeyJwk,
          host_token_hash: hostTokenHash,
          status: networkConfig ? "pending" : "active",
        });
    if (result.kind === "conflict") {
      return c.json(
        {
          success: false,
          error: "Remote host identity is already enrolled",
          code: "CONFLICT",
        },
        409,
      );
    }
    if (
      result.kind === "not_found" ||
      result.kind === "mismatch" ||
      result.kind === "revoked"
    ) {
      return c.json(
        {
          success: false,
          error: "Remote host credential recovery did not match an active host",
          code: "RECOVERY_MISMATCH",
        },
        409,
      );
    }
    let managedNetworkEnrollment: Awaited<
      ReturnType<typeof enrollManagedNetwork>
    > | null = null;
    if (result.kind === "created" && networkConfig) {
      try {
        managedNetworkEnrollment = await enrollManagedNetwork({
          hostId: result.host.id,
          organizationId: user.organization_id,
          userId: user.id,
          config: networkConfig,
          repository: remoteHostsRepository,
        });
      } catch (cause) {
        // The host must never remain authoritative when its requested network
        // enrollment failed. Any incomplete Headscale compensation remains on
        // the revoked row for the retry-safe revoke endpoint.
        await remoteHostsRepository.revoke(
          result.host.id,
          user.organization_id,
          user.id,
        );
        throw cause;
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        success: true,
        data: {
          hostId: result.host.id,
          hostToken: token,
          runtimeKeyId: result.host.runtime_key_id,
          status: managedNetworkEnrollment ? "active" : result.host.status,
          createdAt: result.host.created_at,
          recovered: result.kind === "recovered",
          managedNetworkEnrollment,
        },
      },
      result.kind === "recovered" ? 200 : 201,
    );
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
