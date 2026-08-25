/** Completes only the exact started claim attempt with a target-signed result. */

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
      return c.json(
        { success: false, error: "Result envelope is invalid" },
        400,
      );
    }
    const body = value as Record<string, unknown>;
    const resultEnvelope = parseEncryptedRemoteControlEnvelope(body.envelope);
    if (
      !Number.isSafeInteger(body.claimAttempt) ||
      !isRemotePairingUuid(
        typeof body.claimToken === "string" ? body.claimToken : "",
      ) ||
      !resultEnvelope ||
      resultEnvelope.messageKind !== "result" ||
      resultEnvelope.sessionId !== sessionId ||
      resultEnvelope.commandId !== commandId
    ) {
      return c.json(
        { success: false, error: "Result envelope is invalid" },
        400,
      );
    }
    const result = await remoteCommandEnvelopesRepository.complete({
      sessionId,
      commandId,
      hostId: credential.hostId,
      hostToken: credential.token,
      claimAttempt: body.claimAttempt as number,
      claimToken: body.claimToken as string,
      resultEnvelope,
    });
    if (result.kind === "not_found") {
      return c.json({ success: false, error: "Remote command not found" }, 404);
    }
    if (result.kind === "claim_lost") {
      return c.json(
        {
          success: false,
          error: "Command claim is stale or was not started",
          code: "CLAIM_LOST",
        },
        409,
      );
    }
    if (result.kind === "execution_ambiguous") {
      return c.json(
        {
          success: false,
          error: "Execution may have started but the result deadline elapsed",
          code: "EXECUTION_AMBIGUOUS",
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
        completedAt: result.command.completed_at,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
