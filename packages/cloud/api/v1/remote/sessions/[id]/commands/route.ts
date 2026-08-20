/** Controller enqueue and host claim endpoints for opaque encrypted commands. */
import { Hono } from "hono";
import { remoteCommandEnvelopesRepository } from "@/db/repositories/remote-command-envelopes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { enqueueRemoteCommandSchema } from "../../../command-envelope-schema";
import { authenticateRemoteHost } from "../../../host-auth";

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("id");
    if (!sessionId)
      return c.json({ success: false, error: "Session id required" }, 400);
    const parsed = enqueueRemoteCommandSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid encrypted command" },
        400,
      );
    }
    const now = Date.now();
    if (
      parsed.data.expiresAt <= now - 30_000 ||
      parsed.data.expiresAt > now + 90_000
    ) {
      return c.json(
        { success: false, error: "Command expiry is invalid" },
        400,
      );
    }
    const result = await remoteCommandEnvelopesRepository.enqueue({
      sessionId,
      organizationId: user.organization_id,
      userId: user.id,
      commandId: parsed.data.commandId,
      sequence: parsed.data.sequence,
      expiresAt: new Date(parsed.data.expiresAt),
      envelope: parsed.data.envelope,
    });
    if (result.kind === "not_found") {
      return c.json({ success: false, error: "Remote session not found" }, 404);
    }
    if (result.kind === "replay") {
      return c.json({ success: false, error: "Command was already used" }, 409);
    }
    if (result.kind === "wrong_keys") {
      return c.json(
        { success: false, error: "Command key binding is invalid" },
        403,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        success: true,
        data: {
          commandId: result.command.command_id,
          status: result.command.status,
        },
      },
      202,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const host = await authenticateRemoteHost(c);
    if (!host)
      return c.json(
        { success: false, error: "Host authentication required" },
        401,
      );
    const sessionId = c.req.param("id");
    if (!sessionId)
      return c.json({ success: false, error: "Session id required" }, 400);
    const claimed = await remoteCommandEnvelopesRepository.claimNext(
      sessionId,
      host.id,
    );
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: claimed
        ? {
            commandId: claimed.command.command_id,
            sequence: claimed.command.sequence,
            expiresAt: claimed.command.expires_at,
            envelope: claimed.command.envelope,
            authority: {
              ownerId: claimed.session.user_id,
              sessionId: claimed.session.id,
              targetRuntimeId: claimed.session.host_id,
              controller: {
                version: 1,
                deviceId: claimed.session.controller_device_id,
                keyId: claimed.session.controller_key_id,
                displayName: claimed.session.controller_display_name,
                platform: claimed.session.controller_platform,
                signingPublicKeyJwk:
                  claimed.session.controller_signing_public_jwk,
                encryptionPublicKeyJwk:
                  claimed.session.controller_encryption_public_jwk,
                createdAt: claimed.session.created_at.getTime(),
              },
            },
          }
        : null,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
