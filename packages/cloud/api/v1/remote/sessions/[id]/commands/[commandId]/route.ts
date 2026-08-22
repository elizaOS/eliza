/** Returns an owner-scoped command status and opaque start/result envelopes. */

import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteCommandEnvelopesRepository } from "@/db/repositories/remote-command-envelopes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("id")?.trim() ?? "";
    const commandId = c.req.param("commandId")?.trim() ?? "";
    if (!isRemotePairingUuid(sessionId) || !commandId) {
      return c.json(
        { success: false, error: "Session or command id is invalid" },
        400,
      );
    }
    const command = await remoteCommandEnvelopesRepository.readOwnedResult({
      organizationId: user.organization_id,
      ownerId: user.id,
      sessionId,
      commandId,
    });
    if (!command)
      return c.json({ success: false, error: "Remote command not found" }, 404);
    return c.json({
      success: true,
      data: {
        commandId: command.command_id,
        sequence: command.sequence,
        status: command.status,
        attempts: command.attempts,
        startReceipt: command.start_receipt,
        resultEnvelope: command.result_envelope,
        createdAt: command.created_at,
        startedAt: command.started_at,
        completedAt: command.completed_at,
        terminalAt: command.terminal_at,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
