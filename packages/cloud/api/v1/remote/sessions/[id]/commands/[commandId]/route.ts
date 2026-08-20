/** Host completion and controller result-read endpoint for an opaque command. */
import { Hono } from "hono";
import { remoteCommandEnvelopesRepository } from "@/db/repositories/remote-command-envelopes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import { completeRemoteCommandSchema } from "../../../../command-envelope-schema";
import { authenticateRemoteHost } from "../../../../host-auth";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const host = await authenticateRemoteHost(c);
    if (!host)
      return c.json(
        { success: false, error: "Host authentication required" },
        401,
      );
    const parsed = completeRemoteCommandSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid encrypted result" }, 400);
    }
    const sessionId = c.req.param("id");
    const commandId = c.req.param("commandId");
    if (!sessionId || !commandId)
      return c.json({ success: false, error: "Command path is invalid" }, 400);
    const command = await remoteCommandEnvelopesRepository.complete({
      sessionId,
      commandId,
      hostId: host.id,
      resultEnvelope: parsed.data.resultEnvelope,
    });
    if (!command) {
      return c.json(
        { success: false, error: "Claimed command not found" },
        404,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("id");
    const commandId = c.req.param("commandId");
    if (!sessionId || !commandId)
      return c.json({ success: false, error: "Command path is invalid" }, 400);
    const command = await remoteCommandEnvelopesRepository.readOwnedResult(
      sessionId,
      commandId,
      user.organization_id,
      user.id,
    );
    if (!command)
      return c.json({ success: false, error: "Command not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        commandId: command.command_id,
        status: command.status,
        resultEnvelope: command.result_envelope,
        completedAt: command.completed_at,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
