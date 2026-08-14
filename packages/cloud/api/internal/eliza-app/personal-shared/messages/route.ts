/**
 * Converts an authenticated phone-gateway delivery into one account-native
 * personal Eliza turn. The gateway proves the phone at its provider boundary;
 * this route owns account convergence and rowless Shared execution.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { elizaAppUserService } from "@/lib/services/eliza-app";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import { sharedRestMessageSend } from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const phoneMessageSchema = z.object({
  platform: z.enum(["twilio", "blooio"]),
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/),
  messageId: z.string().trim().min(1).max(96),
  message: z.string().trim().min(1).max(4000),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;
    if (
      auth.service !== "webhook-gateway" &&
      auth.service !== "shared-secret"
    ) {
      return jsonError(c, 403, "Forbidden", "access_denied");
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // error-policy:J3 Provider input that is not JSON is explicitly invalid.
      return jsonError(c, 400, "Invalid phone message", "validation_error");
    }
    const parsed = phoneMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(c, 400, "Invalid phone message", "validation_error");
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

    const account = await elizaAppUserService.findOrCreateByPhone(
      parsed.data.phoneNumber,
    );
    const agent = personalSharedAgent({
      userId: account.user.id,
      organizationId: account.organization.id,
    });
    const result = await sharedRestMessageSend(
      agent,
      agent.id,
      parsed.data.message,
      agent.agent_name ?? "Eliza",
      worker.executionCtx,
      worker.namespace,
      `${parsed.data.platform}:${parsed.data.messageId}`,
      "platform",
    );

    return c.json({
      success: true,
      data: {
        identity: { id: agent.id, runtime: "shared" as const },
        reply: result.text,
      },
    });
  } catch (error) {
    // error-policy:J1 Translate the internal HTTP boundary into one structured failure.
    return failureResponse(c, error);
  }
});

export default app;
