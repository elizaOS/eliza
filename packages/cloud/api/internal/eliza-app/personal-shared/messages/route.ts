/** Runs a trusted messaging delivery through one rowless personal Shared turn. */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { sha256Hex } from "@/lib/oidc/crypto";
import { findActivePersonalDedicatedTarget } from "@/lib/services/agent-tier-upgrade-target";
import { elizaAppUserService } from "@/lib/services/eliza-app";
import { runOnboardingChat } from "@/lib/services/eliza-app/onboarding-chat";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { preparePersonalDedicatedDelivery } from "@/lib/services/personal-dedicated-delivery";
import { coordinateSharedHistory } from "@/lib/services/shared-runtime/conversation-coordinator";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import { sharedRestMessageSend } from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const sharedMessageSchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("telegram"),
    telegramUserId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/),
    telegramUsername: z.string().trim().min(1).max(64).optional(),
    displayName: z.string().trim().min(1).max(128).optional(),
    messageId: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
  }),
  z.object({
    platform: z.enum(["twilio", "blooio"]),
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/),
    messageId: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
  }),
]);

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
      // error-policy:J3 malformed provider input is explicitly invalid.
      return jsonError(
        c,
        400,
        "Invalid messaging delivery",
        "validation_error",
      );
    }
    const parsed = sharedMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "Invalid messaging delivery",
        "validation_error",
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

    const account =
      parsed.data.platform === "telegram"
        ? await elizaAppUserService.findOrCreateByTelegram({
            telegramId: parsed.data.telegramUserId,
            username: parsed.data.telegramUsername,
            displayName: parsed.data.displayName,
          })
        : await elizaAppUserService.findOrCreateByPhone(
            parsed.data.phoneNumber,
          );
    const agent = personalSharedAgent({
      userId: account.user.id,
      organizationId: account.organization.id,
    });
    if (
      parsed.data.platform === "telegram" &&
      /^\/connect(?:@[a-z0-9_]{5,32})?$/i.test(parsed.data.message)
    ) {
      // A new command gets independent expiry while a webhook retry reaches
      // the same session. Reusing the sender's permanent session would make
      // refreshing one claim link revive every expired link for that sender.
      const claimSessionId = `platform:telegram-claim:${await sha256Hex(
        `${parsed.data.telegramUserId}\n${parsed.data.messageId}`,
      )}`;
      const claim = await runOnboardingChat({
        sessionId: claimSessionId,
        platform: "telegram",
        platformUserId: parsed.data.telegramUserId,
        platformDisplayName:
          parsed.data.displayName ??
          parsed.data.telegramUsername ??
          parsed.data.telegramUserId,
        authenticatedUser: {
          userId: account.user.id,
          organizationId: account.organization.id,
          telegramId: parsed.data.telegramUserId,
        },
        trustedPlatformIdentity: true,
        statusOnly: true,
        idempotencyKey: `telegram-account-claim:${parsed.data.messageId}`,
      });
      const loginUrl = new URL(claim.loginUrl);
      loginUrl.searchParams.set("accountClaim", "telegram");
      return c.json({
        success: true,
        data: {
          identity: { id: agent.id, runtime: "shared" as const },
          account: {
            userId: account.user.id,
            organizationId: account.organization.id,
          },
          reply: `Sign in to connect this Telegram chat to your Eliza account: ${loginUrl.toString()}`,
        },
      });
    }
    const dedicated = await findActivePersonalDedicatedTarget(
      account.organization.id,
      agent.id,
    );
    if (dedicated) {
      const preparation = await preparePersonalDedicatedDelivery(
        dedicated,
        {
          organizationId: account.organization.id,
          userId: account.user.id,
        },
        c.env,
        worker.executionCtx,
      );
      if (preparation.state === "blocked") {
        return c.json(
          {
            success: false,
            code: preparation.code,
            error: preparation.error,
            retryable: false,
            currentBalance: preparation.currentBalance,
          },
          402,
        );
      }
      if (preparation.state === "starting") {
        return c.json(
          {
            success: false,
            code: "dedicated_starting",
            error: "Dedicated Eliza is waking up. Retry this turn shortly.",
            retryable: true,
            data: {
              action: preparation.action,
              activeAgentId: dedicated.id,
              alreadyInProgress: !preparation.created,
              jobId: preparation.jobId,
            },
          },
          503,
          { "Retry-After": String(preparation.retryAfterSeconds) },
        );
      }
      if (preparation.state === "unavailable") {
        return c.json(
          {
            success: false,
            code: preparation.code,
            error: preparation.error,
            retryable: preparation.retryable,
          },
          preparation.status,
          preparation.retryAfterSeconds
            ? { "Retry-After": String(preparation.retryAfterSeconds) }
            : undefined,
        );
      }
      const bridgeRequest = {
        jsonrpc: "2.0" as const,
        id: parsed.data.messageId,
        method: "message.send",
        params: {
          text: parsed.data.message,
          roomId: agent.id,
          conversationId: agent.id,
          canonicalBridgeBase: dedicated.bridge_url,
          userId: account.user.id,
          clientMessageId: parsed.data.messageId,
          platformName: parsed.data.platform,
          source: parsed.data.platform,
          ...(parsed.data.platform === "telegram"
            ? {
                senderName:
                  parsed.data.displayName ?? parsed.data.telegramUsername,
              }
            : {}),
        },
      };
      let response = await elizaSandboxService.bridge(
        dedicated.id,
        account.organization.id,
        bridgeRequest,
      );
      if (response.error?.message === "Bridge returned HTTP 404") {
        const history = await coordinateSharedHistory(agent.id, agent.id, {
          namespace: worker.namespace,
        });
        const importMessages = history.flatMap((message) =>
          message.id
            ? [
                {
                  sourceId: message.id,
                  role: message.role,
                  text: message.content,
                  ...(typeof message.createdAt === "number"
                    ? { timestamp: message.createdAt }
                    : {}),
                },
              ]
            : [],
        );
        let receipt =
          importMessages.length === history.length
            ? await elizaSandboxService.importCanonicalConversation(
                dedicated.id,
                account.organization.id,
                agent.id,
                importMessages,
              )
            : null;
        if (!receipt && importMessages.length > 0) {
          receipt = await elizaSandboxService.importCanonicalConversation(
            dedicated.id,
            account.organization.id,
            agent.id,
            [],
          );
        }
        if (receipt) {
          response = await elizaSandboxService.bridge(
            dedicated.id,
            account.organization.id,
            bridgeRequest,
          );
        }
      }
      if (response.error) {
        return jsonError(
          c,
          503,
          "Dedicated Eliza is temporarily unavailable.",
          "service_unavailable",
        );
      }
      const result = response.result as { text?: unknown } | undefined;
      if (typeof result?.text !== "string") {
        return jsonError(
          c,
          503,
          "Dedicated Eliza returned an invalid reply.",
          "service_unavailable",
        );
      }
      return c.json({
        success: true,
        data: {
          identity: {
            id: agent.id,
            runtime: "dedicated" as const,
            activeAgentId: dedicated.id,
          },
          account: {
            userId: account.user.id,
            organizationId: account.organization.id,
          },
          reply: result.text,
        },
      });
    }
    const result = await sharedRestMessageSend(
      agent,
      agent.id,
      parsed.data.message,
      agent.agent_name ?? "Eliza",
      worker.executionCtx,
      worker.namespace,
      parsed.data.messageId,
      "platform",
    );

    return c.json({
      success: true,
      data: {
        identity: { id: agent.id, runtime: "shared" as const },
        account: {
          userId: account.user.id,
          organizationId: account.organization.id,
        },
        reply: result.text,
      },
    });
  } catch (error) {
    // error-policy:J1 the internal HTTP boundary emits one structured failure.
    return failureResponse(c, error);
  }
});

export default app;
