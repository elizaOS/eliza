/**
 * Authenticated gateway boundary for managed Discord guild-voice ownership and
 * public-room Shared Eliza turns.
 */
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import {
  authorizeManagedDiscordGuildVoice,
  runManagedDiscordGuildVoiceTurn,
} from "@/lib/services/managed-discord-guild-voice";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const snowflake = z
  .string()
  .trim()
  .regex(/^\d{15,22}$/);
const authorizationSchema = z.object({
  action: z.literal("authorize"),
  discordUserId: snowflake,
  guildId: snowflake,
});
const turnSchema = z.object({
  action: z.literal("turn"),
  discordUserId: snowflake,
  discordUsername: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(128).optional(),
  guildId: snowflake,
  channelId: snowflake,
  utteranceId: z.string().trim().min(1).max(180),
  wavBase64: z.string().min(60).max(11_200_000),
});
const requestSchema = z.discriminatedUnion("action", [
  authorizationSchema,
  turnSchema,
]);

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;
    if (
      auth.service !== "discord-gateway" &&
      auth.service !== "shared-secret"
    ) {
      return jsonError(c, 403, "Forbidden", "access_denied");
    }

    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      // error-policy:J3 malformed gateway input is explicitly invalid.
      return jsonError(
        c,
        400,
        "Invalid guild voice request",
        "validation_error",
      );
    }
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "Invalid guild voice request",
        "validation_error",
      );
    }

    const identity = await authorizeManagedDiscordGuildVoice(
      parsed.data.discordUserId,
    );
    if (parsed.data.action === "authorize") return c.json(identity);
    if (!identity.allowed) {
      return jsonError(
        c,
        403,
        "Canonical owner authorization required",
        "access_denied",
      );
    }

    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    if ("error" in worker) {
      return c.json(
        {
          success: false,
          error: worker.error,
          code: worker.code,
          retryable: worker.retryable,
        },
        worker.status,
        { "Retry-After": "1" },
      );
    }
    const result = await runManagedDiscordGuildVoiceTurn(parsed.data, {
      namespace: worker.namespace,
      executionCtx: worker.executionCtx,
      elevenLabsEnv: c.env,
    });
    return c.json(result);
  } catch (error) {
    // error-policy:J1 the trusted HTTP boundary emits one structured failure.
    return failureResponse(c, error);
  }
});

export default app;
