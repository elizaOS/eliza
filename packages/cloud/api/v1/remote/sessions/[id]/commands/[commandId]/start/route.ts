/** Persists the host-signed receipt that crosses the no-retry boundary. */

import { parseEncryptedRemoteControlEnvelope } from "@elizaos/shared/contracts/remote-control";
import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteCommandEnvelopesRepository } from "@/db/repositories/remote-command-envelopes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseRemoteHostCredential } from "../../../../../host-auth";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const sessionId = c.req.param("id")?.trim() ?? "";
    const commandId = c.req.param("commandId")?.trim() ?? "";
    if (!isRemotePairingUuid(sessionId) || !commandId) {
      return c.json(
        { success: false, error: "Session or command id is invalid" },
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
      return c.json({ success: false, error: "Start receipt is invalid" }, 400);
    }
    const body = value as Record<string, unknown>;
    const startReceipt = parseEncryptedRemoteControlEnvelope(body.envelope);
    if (
      !Number.isSafeInteger(body.claimAttempt) ||
      !isRemotePairingUuid(
        typeof body.claimToken === "string" ? body.claimToken : "",
      ) ||
      !startReceipt ||
      startReceipt.messageKind !== "start_receipt" ||
      startReceipt.sessionId !== sessionId ||
      startReceipt.commandId !== commandId
    ) {
      return c.json({ success: false, error: "Start receipt is invalid" }, 400);
    }
    const result = await remoteCommandEnvelopesRepository.recordStart({
      sessionId,
      commandId,
      hostId: credential.hostId,
      hostToken: credential.token,
      claimAttempt: body.claimAttempt as number,
      claimToken: body.claimToken as string,
      startReceipt,
    });
    if (result.kind === "not_found") {
      return c.json({ success: false, error: "Remote command not found" }, 404);
    }
    if (result.kind === "claim_lost") {
      return c.json(
        {
          success: false,
          error: "Command claim is stale or expired",
          code: "CLAIM_LOST",
        },
        409,
      );
    }
    return c.json({
      success: true,
      data: {
        commandId: result.command.command_id,
        status: result.command.status,
        duplicate: result.kind === "duplicate",
        startedAt: result.command.started_at,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
