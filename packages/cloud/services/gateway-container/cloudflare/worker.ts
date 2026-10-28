import { handleDiscordCoordination } from "./discord-coordination-state";

export { DiscordCoordinationState } from "./discord-coordination-state";

/** Hosts the existing gateway processes; their configured stores retain authority. */
import { Container, getContainer } from "@cloudflare/containers";
import { handleWebhookIngress } from "./webhook-ingress-state";

export { WebhookIngressState } from "./webhook-ingress-state";

import { handleDiscordWelcome } from "./discord-welcome-state";

export { DiscordWelcomeState } from "./discord-welcome-state";

import { configurationProof } from "./configuration-proof";
import { handleDeliveryReceipts } from "./delivery-receipt-state";

export { DeliveryReceiptState } from "./delivery-receipt-state";

import { handleNetworkConsent } from "./network-consent-state";

export { NetworkConsentState } from "./network-consent-state";

interface Env {
  DISCORD_COORDINATION_STATE?: DurableObjectNamespace;
  DISCORD_WELCOME_STATE?: DurableObjectNamespace;
  WEBHOOK_INGRESS_STATE?: DurableObjectNamespace;
  DELIVERY_RECEIPT_STATE?: DurableObjectNamespace;
  NETWORK_CONSENT_STATE?: DurableObjectNamespace;
  GATEWAY: DurableObjectNamespace<GatewayContainer>;
  GATEWAY_ENABLED: string;
  GATEWAY_KIND: string;
  DEPLOYMENT_ENV: string;
  GATEWAY_RUNTIME_CONFIG?: string;
  BUILD_ID: string;
}

export class GatewayContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "30m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    if (!["webhook", "discord"].includes(env.GATEWAY_KIND)) {
      throw new Error("GATEWAY_KIND must identify the deployed gateway image");
    }
    if (!/^[a-f0-9]{40}$/.test(env.BUILD_ID)) {
      throw new Error("BUILD_ID must identify the deployed runtime source");
    }
    const config: unknown = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "null");
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("GATEWAY_RUNTIME_CONFIG must be a settings object");
    }
    const settings: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== "string") {
        throw new Error("Gateway settings must be strings");
      }
      // The image supplies its source marker; runtime settings cannot replace it.
      if (!key.startsWith("RAILWAY_") && key !== "ELIZA_GATEWAY_SOURCE_SHA") {
        settings[key] = value;
      }
    }
    if (
      !["staging", "production"].includes(env.DEPLOYMENT_ENV) ||
      (settings.ENVIRONMENT && settings.ENVIRONMENT !== env.DEPLOYMENT_ENV)
    ) {
      throw new Error(
        "Gateway configuration does not match deployment environment",
      );
    }
    if (!settings.GATEWAY_BOOTSTRAP_SECRET?.trim()) {
      throw new Error("GATEWAY_BOOTSTRAP_SECRET is required");
    }
    if (!settings.REDIS_URL && !settings.KV_REST_API_URL) {
      throw new Error("A durable gateway state service is required");
    }
    for (const key of ["REDIS_URL", "KV_REST_API_URL"]) {
      if (!settings[key]) continue;
      const endpoint = new URL(settings[key]);
      if (endpoint.hostname.endsWith(".railway.internal")) {
        throw new Error(`${key} must be reachable from Cloudflare`);
      }
    }
    this.envVars = {
      ...settings,
      PORT: "3000",
      BUILD_ID: env.BUILD_ID,
      POD_NAME: `cloudflare-${env.GATEWAY_KIND}-${crypto.randomUUID()}`,
    };
  }
}

async function stopInactiveGateway(env: Env): Promise<void> {
  if (env.GATEWAY_RUNTIME_CONFIG) {
    await getContainer(env.GATEWAY, "gateway").stop();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/discord-coordination")
      return handleDiscordCoordination(request, env);
    if (new URL(request.url).pathname === "/internal/discord-welcome")
      return handleDiscordWelcome(request, env);
    if (new URL(request.url).pathname === "/internal/webhook-ingress")
      return handleWebhookIngress(request, env);
    if (new URL(request.url).pathname === "/internal/delivery-receipts")
      return handleDeliveryReceipts(request, env);
    if (new URL(request.url).pathname === "/internal/network-consent")
      return handleNetworkConsent(request, env);
    if (new URL(request.url).pathname === "/internal/configuration-proof") {
      return configurationProof(request, env);
    }
    if (env.GATEWAY_ENABLED !== "true") {
      await stopInactiveGateway(env);
      return new Response("Gateway deployment inactive", { status: 503 });
    }
    // Keep the raw body and signed headers for the existing gateway to verify.
    const upstream = await getContainer(env.GATEWAY, "gateway").fetch(request);
    if (upstream.webSocket) return upstream;
    const response = new Response(upstream.body, upstream);
    response.headers.set("x-eliza-gateway-host", "cloudflare");
    response.headers.set("x-eliza-gateway-environment", env.DEPLOYMENT_ENV);
    response.headers.set("x-eliza-gateway-source", env.BUILD_ID);
    return response;
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.GATEWAY_ENABLED !== "true") {
      await stopInactiveGateway(env);
      return;
    }
    const response = await getContainer(env.GATEWAY, "gateway").fetch(
      "http://gateway/health",
    );
    if (!response.ok) {
      throw new Error(`Gateway health check failed (${response.status})`);
    }
    await response.body?.cancel();
  },
};
