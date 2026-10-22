/** Hosts the existing gateway processes; their configured stores retain authority. */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
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
      if (!key.startsWith("RAILWAY_")) settings[key] = value;
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
    if (env.GATEWAY_ENABLED !== "true") {
      await stopInactiveGateway(env);
      return new Response("Gateway deployment inactive", { status: 503 });
    }
    // Keep the raw body and signed headers for the existing gateway to verify.
    return getContainer(env.GATEWAY, "gateway").fetch(request);
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
