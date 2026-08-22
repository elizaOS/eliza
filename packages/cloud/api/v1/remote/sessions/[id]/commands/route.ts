/** Enqueues owner-authenticated commands and leases them to the bound host. */

import { parseEncryptedRemoteControlEnvelope } from "@elizaos/shared/contracts/remote-control";
import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteCommandEnvelopesRepository } from "@/db/repositories/remote-command-envelopes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseRemoteHostCredential } from "../../../host-auth";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("id")?.trim() ?? "";
    if (!isRemotePairingUuid(sessionId)) {
      return c.json(
        { success: false, error: "Session id must be a UUID" },
        400,
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
    const rawEnvelope =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).envelope
        : undefined;
    const envelope = parseEncryptedRemoteControlEnvelope(rawEnvelope);
    if (
      envelope?.messageKind !== "command" ||
      envelope.sessionId !== sessionId
    ) {
      return c.json(
        { success: false, error: "Command envelope is invalid" },
        400,
      );
    }
    if (envelope.ownerId !== user.id) {
      return c.json({ success: false, error: "Remote session not found" }, 404);
    }

    const result = await remoteCommandEnvelopesRepository.enqueue({
      organizationId: user.organization_id,
      ownerId: user.id,
      envelope,
    });
    if (result.kind === "not_found") {
      return c.json({ success: false, error: "Remote session not found" }, 404);
    }
    if (result.kind === "expired") {
      return c.json(
        { success: false, error: "Remote grant or command expired" },
        410,
      );
    }
    if (result.kind === "replay") {
      return c.json(
        {
          success: false,
          error: "Command id, sequence, or nonce was already used",
          code: "REPLAY",
        },
        409,
      );
    }
    if (result.kind === "sequence_gap") {
      return c.json(
        {
          success: false,
          error: "Command sequence must be contiguous",
          code: "SEQUENCE_GAP",
        },
        409,
      );
    }
    if (result.kind === "session_capacity") {
      return c.json(
        {
          success: false,
          error:
            "Remote session replay capacity is exhausted; create a new session",
          code: "SESSION_CAPACITY",
        },
        409,
      );
    }
    return c.json(
      {
        success: true,
        data: {
          commandId: result.command.command_id,
          sequence: result.command.sequence,
          status: result.command.status,
          duplicate: result.kind === "duplicate",
          expiresAt: result.command.expires_at,
        },
      },
      result.kind === "queued" ? 202 : 200,
    );
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
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
    const result = await remoteCommandEnvelopesRepository.claimNext({
      sessionId,
      hostId: credential.hostId,
      hostToken: credential.token,
    });
    if (result.kind === "not_found") {
      return c.json({ success: false, error: "Remote session not found" }, 404);
    }
    if (result.kind === "empty") return c.body(null, 204);
    return c.json({
      success: true,
      data: {
        commandId: result.command.command_id,
        sequence: result.command.sequence,
        envelope: result.command.envelope,
        claimAttempt: result.command.attempts,
        claimToken: result.command.claim_token,
        claimExpiresAt: result.command.claim_expires_at,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
