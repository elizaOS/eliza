/** Owns value-safe canonical Telegram identity gates for the Railway gateway. */

import {
  attestTelegramBotIdentity,
  TelegramIdentityAttestationError,
  type TelegramIdentityAttestationFailureReason,
} from "@elizaos/cloud-services-common/telegram-connector";
import type { Hono } from "hono";
import type { WebhookConfig } from "./adapters/types";
import { resolveSharedWebhookConfig } from "./webhook-config";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

export function canonicalTelegramProject(): string {
  return (
    (process.env.ELIZA_APP_WEBHOOK_PROJECT ?? "eliza-app").trim() || "eliza-app"
  );
}

export function isCanonicalTelegramProject(
  project: string,
  agentId?: string,
): boolean {
  return !agentId && project === canonicalTelegramProject();
}

export function telegramIdentityFailureReason(
  error: unknown,
): TelegramIdentityAttestationFailureReason {
  return error instanceof TelegramIdentityAttestationError
    ? error.reason
    : "provider_unavailable";
}

export async function requireCanonicalTelegramIdentity(
  config: WebhookConfig,
): Promise<void> {
  if (!config.webhookSecret?.trim()) {
    throw new TelegramIdentityAttestationError("not_configured", false);
  }
  await attestTelegramBotIdentity(config);
}

export function telegramIdentityNotReadyResponse(error: unknown): Response {
  return new Response(
    JSON.stringify({
      error: "telegram-identity-not-ready",
      reason: telegramIdentityFailureReason(error),
      status: "not-attested",
    }),
    {
      status: 503,
      headers: {
        ...JSON_HEADERS,
        "retry-after": "5",
        "x-eliza-failure-name": "TelegramIdentityAttestationError",
        "x-eliza-failure-stage": "connector_identity",
      },
    },
  );
}

export async function attestCanonicalTelegramProject(): Promise<void> {
  const project = canonicalTelegramProject();
  await requireCanonicalTelegramIdentity(
    resolveSharedWebhookConfig("telegram", project),
  );
}

/** Registers a public value-free readiness proof for protected deployments. */
export function registerTelegramIdentityReadinessRoute(app: Hono): void {
  app.get("/ready/telegram-identity/:project", async (context) => {
    const project = context.req.param("project");
    if (project !== canonicalTelegramProject()) {
      return new Response(
        JSON.stringify({
          error: "telegram-identity-project-mismatch",
          status: "not-attested",
        }),
        { status: 409, headers: JSON_HEADERS },
      );
    }
    try {
      await attestCanonicalTelegramProject();
      return new Response(JSON.stringify({ project, status: "attested" }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (error) {
      // error-policy:J1 the public readiness boundary exposes only the bounded
      // attestation classification.
      return telegramIdentityNotReadyResponse(error);
    }
  });
}
