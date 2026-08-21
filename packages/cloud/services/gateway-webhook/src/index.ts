/** Assembles and starts the authenticated multi-platform webhook gateway. */
import { Hono } from "hono";
import { blooioAdapter } from "./adapters/blooio";
import { telegramAdapter } from "./adapters/telegram";
import { twilioAdapter } from "./adapters/twilio";
import type { Platform, PlatformAdapter } from "./adapters/types";
import { whatsappAdapter } from "./adapters/whatsapp";
import { getAuthHeader, initAuth, shutdownAuth } from "./auth";
import { registerForwarderAuthReadinessRoute } from "./forwarder-auth-readiness";
import {
  enforceForwarderSecret,
  validateInternalSecret,
} from "./internal-auth";
import { deliverInternalMessage } from "./internal-delivery";
import { handleInternalEvent } from "./internal-event-handler";
import { logger } from "./logger";
import { initProjectConfig, shutdownProjectConfig } from "./project-config";
import { createRedis } from "./redis";
import { requireCanonicalAgentRoutingConfiguration } from "./server-router";
import {
  getSharedWhatsAppVerifyToken,
  resolveWebhookConfig,
} from "./webhook-config";
import { handleWebhook } from "./webhook-handler";

const PORT = Number(process.env.PORT ?? 3000);
const POD_NAME =
  process.env.POD_NAME ?? process.env.HOSTNAME ?? "webhook-local";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const ELIZA_CLOUD_URL = requireEnv("ELIZA_CLOUD_URL");
const GATEWAY_BOOTSTRAP_SECRET = requireEnv("GATEWAY_BOOTSTRAP_SECRET");

const adapters: Record<Platform, PlatformAdapter> = {
  telegram: telegramAdapter,
  blooio: blooioAdapter,
  twilio: twilioAdapter,
  whatsapp: whatsappAdapter,
};

const SUPPORTED_PLATFORMS = new Set<string>(Object.keys(adapters));

let draining = false;

const redis = createRedis();

const app = new Hono();

app.get("/health", (c) =>
  c.json({ status: draining ? "draining" : "healthy", pod: POD_NAME }),
);
app.get("/ready", (c) => {
  if (draining) return c.json({ status: "draining" }, 503);
  return c.json({ status: "ready" });
});
registerForwarderAuthReadinessRoute(app);
app.post("/drain", (c) => {
  // Gated on the internal secret like /internal/deliver: this service is the
  // public webhook ingress, so an unauthenticated drain would let anyone who
  // reaches it latch every replica into the draining state (/ready 503s until
  // restart). /health and /ready stay open because probes cannot attach
  // headers.
  if (!validateInternalSecret(c.req.raw)) {
    return c.json({ success: false, error: "unauthorized" }, 401);
  }
  draining = true;
  logger.info("Drain requested");
  return c.json({ status: "draining" });
});

// ── Internal event and connector delivery ──

app.post("/internal/event", async (c) => {
  return handleInternalEvent(c.req.raw, { redis });
});

app.post("/internal/deliver", async (c) => {
  if (!validateInternalSecret(c.req.raw)) {
    return c.json({ success: false, error: "unauthorized" }, 401);
  }
  return deliverInternalMessage(c.req.raw, {
    redis,
  });
});

// ── Platform webhooks ──

app.get("/webhook/:project/whatsapp", async (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  const verifyToken = getSharedWhatsAppVerifyToken(c.req.param("project"));
  if (mode === "subscribe" && token === verifyToken && challenge) {
    logger.info("WhatsApp webhook verified (shared)");
    return c.text(challenge, 200);
  }
  return c.text("Forbidden", 403);
});

app.get("/webhook/:project/whatsapp/:agentId", async (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const agentId = c.req.param("agentId");

  const config = await resolveWebhookConfig(
    redis,
    ELIZA_CLOUD_URL,
    getAuthHeader(),
    "whatsapp",
    c.req.param("project"),
    agentId,
  );

  if (
    mode === "subscribe" &&
    config?.verifyToken &&
    token === config.verifyToken &&
    challenge
  ) {
    logger.info("WhatsApp webhook verified", { agentId });
    return c.text(challenge, 200);
  }
  return c.text("Forbidden", 403);
});

app.post("/webhook/:project/:platform", async (c) => {
  const platform = c.req.param("platform");

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return c.json({ error: "unsupported platform" }, 400);
  }

  // L3: when ELIZA_APP_WEBHOOK_GATEWAY_SECRET is set, only accept requests for
  // the forwarded project that carry the BFF forwarder's dedicated header.
  // No-op when the secret is unset, and never gates other projects/tenants.
  if (!enforceForwarderSecret(c.req.raw, c.req.param("project"))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const adapter = adapters[platform as Platform];
  return handleWebhook(
    c.req.raw,
    adapter,
    {
      redis,
      cloudBaseUrl: ELIZA_CLOUD_URL,
      deliveryAuthoritySecret:
        process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET ?? "",
      getAuthHeader,
    },
    c.req.param("project"),
  );
});

app.post("/webhook/:project/:platform/:agentId", async (c) => {
  const platform = c.req.param("platform");

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return c.json({ error: "unsupported platform" }, 400);
  }

  if (!enforceForwarderSecret(c.req.raw, c.req.param("project"))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const adapter = adapters[platform as Platform];
  return handleWebhook(
    c.req.raw,
    adapter,
    {
      redis,
      cloudBaseUrl: ELIZA_CLOUD_URL,
      deliveryAuthoritySecret:
        process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET ?? "",
      getAuthHeader,
    },
    c.req.param("project"),
    c.req.param("agentId"),
  );
});

async function start() {
  requireCanonicalAgentRoutingConfiguration();
  logger.info("Starting webhook gateway", { pod: POD_NAME, port: PORT });

  await initProjectConfig();
  await initAuth({
    cloudUrl: ELIZA_CLOUD_URL,
    bootstrapSecret: GATEWAY_BOOTSTRAP_SECRET,
    podName: POD_NAME,
  });

  Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });

  if (!process.env.GATEWAY_INTERNAL_SECRET) {
    logger.warn(
      "GATEWAY_INTERNAL_SECRET is not configured — internal delivery routes will reject all requests",
    );
  }

  logger.info("Webhook gateway listening", { port: PORT });
}

function shutdown(signal: string) {
  logger.info("Shutdown signal received", { signal });
  draining = true;
  shutdownProjectConfig();
  shutdownAuth();
  const quitPromise = redis.quit?.();
  quitPromise?.catch((err) => {
    logger.warn("Failed to close Redis connection", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
  logger.error("Failed to start webhook gateway", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
