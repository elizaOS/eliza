import { timingSafeEqual } from "node:crypto";
import { Container, getContainer } from "@cloudflare/containers";
import { TunnelState } from "./state";

export { TunnelState };

interface Env {
  PROXY: DurableObjectNamespace<TunnelContainer>;
  STATE: DurableObjectNamespace<TunnelState>;
  TUNNEL_ENABLED: string;
  TUNNEL_RUNTIME_CONFIG?: string;
  TSNET_STATE_URL: string;
  TSNET_STATE_TOKEN: string;
}
export class TunnelContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "30m";
  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    let settings: unknown;
    try {
      settings = JSON.parse(env.TUNNEL_RUNTIME_CONFIG ?? "null");
    } catch {
      throw new Error("Invalid tunnel runtime configuration JSON");
    }
    if (
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings) ||
      !Object.values(settings).every((v) => typeof v === "string")
    )
      throw new Error(
        "Tunnel runtime configuration must contain string settings",
      );
    const values = settings as Record<string, string>;
    for (const key of [
      "HEADSCALE_PUBLIC_URL",
      "TUNNEL_PROXY_TS_AUTHKEY",
      "TUNNEL_PROXY_HOST",
      "TUNNEL_TAILNET_DOMAIN",
      "TUNNEL_HOSTNAME_SIGNING_SECRET",
      "TUNNEL_PROXY_HOSTNAME",
    ])
      if (!values[key]?.trim())
        throw new Error(`Missing tunnel setting: ${key}`);
    if (
      !env.TSNET_STATE_URL?.startsWith("https://") ||
      !env.TSNET_STATE_TOKEN?.trim()
    )
      throw new Error("Durable tunnel state configuration required");
    this.envVars = {
      ...values,
      PORT: "8080",
      TSNET_STATE_URL: env.TSNET_STATE_URL,
      TSNET_STATE_TOKEN: env.TSNET_STATE_TOKEN,
    };
  }
}
async function stop(env: Env) {
  if (env.TUNNEL_RUNTIME_CONFIG) await getContainer(env.PROXY, "proxy").stop();
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/tsnet-state") {
      if (!env.TSNET_STATE_TOKEN?.trim())
        return new Response("State unavailable", { status: 503 });
      const actual = new TextEncoder().encode(
        request.headers.get("Authorization") ?? "",
      );
      const expected = new TextEncoder().encode(
        `Bearer ${env.TSNET_STATE_TOKEN}`,
      );
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return new Response("Unauthorized", { status: 401 });
      return env.STATE.get(env.STATE.idFromName("identity")).fetch(request);
    }
    if (env.TUNNEL_ENABLED !== "true") {
      await stop(env);
      return new Response("Tunnel inactive", { status: 503 });
    }
    return getContainer(env.PROXY, "proxy").fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.TUNNEL_ENABLED !== "true") {
      await stop(env);
      return;
    }
    const response = await getContainer(env.PROXY, "proxy").fetch(
      "http://tunnel/ready",
    );
    if (!response.ok)
      throw new Error(`Tunnel readiness failed (${response.status})`);
    await response.body?.cancel();
  },
};
