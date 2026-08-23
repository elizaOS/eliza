/**
 * Stages one exact host-bound pairing session, then exposes authenticated,
 * idempotent commit or rollback after the target durably installs authority.
 */

import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseRemoteHostCredential } from "../../../host-auth";

const app = new Hono<AppEnv>();

app.put("/", async (c) => {
  try {
    const sessionId = c.req.param("id")?.trim() ?? "";
    if (!isRemotePairingUuid(sessionId)) {
      return c.json(
        { success: false, error: "Session id must be a UUID" },
        400,
      );
    }
    const credential = parseRemoteHostCredential(c.req.raw);
    if (!credential) {
      return c.json(
        { success: false, error: "Remote host authentication required" },
        401,
      );
    }
    const result = await remoteSessionsRepository.commitHostActivation({
      sessionId,
      hostId: credential.hostId,
      hostToken: credential.token,
    });
    if (result.kind === "not_found") {
      return c.json({ success: false, error: "Remote session not found" }, 404);
    }
    if (result.kind === "conflict") {
      return c.json(
        {
          success: false,
          error: "Remote activation is no longer committable",
          code: "REMOTE_ACTIVATION_COMMIT_CONFLICT",
        },
        409,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        sessionId: result.session.id,
        status: result.session.status,
        alreadyCommitted: result.alreadyCommitted,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const sessionId = c.req.param("id")?.trim() ?? "";
    if (!isRemotePairingUuid(sessionId)) {
      return c.json(
        { success: false, error: "Session id must be a UUID" },
        400,
      );
    }
    const credential = parseRemoteHostCredential(c.req.raw);
    if (!credential) {
      return c.json(
        { success: false, error: "Remote host authentication required" },
        401,
      );
    }
    const result = await remoteSessionsRepository.compensateHostActivation({
      sessionId,
      hostId: credential.hostId,
      hostToken: credential.token,
    });
    if (result.kind === "not_found") {
      return c.json({ success: false, error: "Remote session not found" }, 404);
    }
    if (result.kind === "conflict") {
      return c.json(
        {
          success: false,
          error: "Remote session is not an active activation",
          code: "REMOTE_ACTIVATION_COMPENSATION_CONFLICT",
        },
        409,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        sessionId: result.session.id,
        status: result.session.status,
        alreadyCompensated: result.alreadyCompensated,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const sessionId = c.req.param("id")?.trim() ?? "";
    if (!isRemotePairingUuid(sessionId)) {
      return c.json(
        { success: false, error: "Session id must be a UUID" },
        400,
      );
    }
    const credential = parseRemoteHostCredential(c.req.raw);
    if (!credential) {
      return c.json(
        { success: false, error: "Remote host authentication required" },
        401,
      );
    }
    const pairingSecret = c.env.REMOTE_PAIRING_HMAC_SECRET?.trim();
    if (
      !pairingSecret ||
      new TextEncoder().encode(pairingSecret).byteLength < 32
    ) {
      return c.json(
        {
          success: false,
          error: "Remote pairing is unavailable",
          code: "REMOTE_PAIRING_NOT_CONFIGURED",
        },
        503,
      );
    }
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
    const code =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).code
        : undefined;
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return c.json(
        { success: false, error: "code must contain exactly six digits" },
        400,
      );
    }

    const result = await remoteSessionsRepository.activatePendingHost({
      sessionId,
      hostId: credential.hostId,
      hostToken: credential.token,
      code,
      pairingSecret,
    });
    if (result.kind !== "activated") {
      return c.json(
        { success: false, error: "Pairing session not found or invalid" },
        404,
      );
    }
    const session = result.session;
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        sessionId: session.id,
        grantId: session.grant_id,
        grantRevision: session.grant_revision,
        ownerId: session.user_id,
        controllerDeviceId: session.controller_device_id,
        controllerKeyId: session.controller_key_id,
        controllerDisplayName: session.controller_display_name,
        controllerPlatform: session.controller_platform,
        controllerSigningPublicKeyJwk: session.controller_signing_public_jwk,
        controllerEncryptionPublicKeyJwk:
          session.controller_encryption_public_jwk,
        targetRuntimeId: session.host_id,
        targetKeyId: session.target_key_id,
        controllerCreatedAt: session.created_at,
        grantExpiresAt: session.grant_expires_at,
        status: session.status,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
