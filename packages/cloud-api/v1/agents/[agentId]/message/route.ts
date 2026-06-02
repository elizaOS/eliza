/**
 * POST /api/v1/agents/[agentId]/message
 *
 * Service-key-authed patron chat proxy. waifu-core's `sendAgentMessage`
 * (ElizaCloudClient) posts here with `{ userId, text, sessionId? }` and reads
 * the reply text back. This is the patron <-> hosted-agent chat path for
 * waifu.fun: it resolves the agent's sandbox (bridge_url + ELIZA_API_TOKEN +
 * runtime agent id) under the waifu service org and forwards the turn to the
 * running container via `elizaSandboxService.bridge(... message.send ...)`,
 * which already implements the robust multi-strategy send (native JSON-RPC,
 * conversation message, OpenAI chat-completion, central-channel) with
 * no-reply fallback.
 *
 * Auth: X-Service-Key (WAIFU_SERVICE_KEY) — same as the provision route. The
 * org/user are mapped from WAIFU_SERVICE_ORG_ID / WAIFU_SERVICE_USER_ID, so a
 * service caller can only chat agents owned by the service org.
 *
 * The response flattens the bridge `result` to the top level so the caller can
 * read `text` directly (matching ElizaCloudClient's `extractReplyText`, which
 * reads top-level `text`/`message`/`reply`).
 */
import { z } from "zod";
import { Hono } from "hono";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const messageRequestSchema = z.object({
  text: z.string().min(1).max(8000),
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
});

async function __hono_POST(c: AppContext) {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const body = await c.req.json().catch(() => null);

    const parsed = messageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid message request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const { text, userId, sessionId, roomId } = parsed.data;

    const rpc: BridgeRequest = {
      jsonrpc: "2.0",
      method: "message.send",
      params: {
        text,
        ...(userId ? { userId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(roomId ? { roomId } : {}),
      },
    };

    const response = await elizaSandboxService.bridge(
      agentId,
      identity.organizationId,
      rpc,
    );

    if (response.error) {
      logger.warn("[agents/message] bridge returned error", {
        agentId,
        code: response.error.code,
        message: response.error.message,
      });
      return c.json(
        { success: false, error: response.error.message },
        502,
      );
    }

    // Flatten result to top level so callers reading `text` work directly.
    return c.json({ success: true, ...(response.result ?? {}) });
  } catch (error) {
    return failureResponse(c, error);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", (c) => __hono_POST(c));
export default __hono_app;
