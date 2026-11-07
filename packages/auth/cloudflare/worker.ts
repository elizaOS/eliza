/** Hosts the unchanged login runtime in a Cloudflare Container behind the Cloudflare edge. */

import { timingSafeEqual } from "node:crypto";
import { Container, getContainer } from "@cloudflare/containers";
import { LoginAggregations } from "./aggregation";
import { verifiedProxyClientIp } from "./client-ip";
import { LoginRateLimits } from "./rate-limit";

import { LoginSpendMetrics } from "./spend-metrics";

export { LoginAggregations, LoginRateLimits, LoginSpendMetrics };

interface Env {
  LOGIN: DurableObjectNamespace<LoginContainer>;
  AGGREGATIONS: DurableObjectNamespace<LoginAggregations>;
  SPEND_METRICS: DurableObjectNamespace<LoginSpendMetrics>;
  RATE_LIMITS: DurableObjectNamespace<LoginRateLimits>;
  /** Deployment-owned settings and secrets. Never derived from a request. */
  [key: string]: unknown;
}

const REQUIRED_RUNTIME_SETTINGS = [
  "DATABASE_URL",
  "STEWARD_MASTER_PASSWORD",
  "STEWARD_JWT_SECRET",
  "STEWARD_KDF_SALT",
  "STEWARD_AUDIT_HMAC_KEY",
] as const;

async function stopInactiveRuntime(env: Env): Promise<void> {
  // A newly provisioned state service has no login credentials or running process.
  if (
    !REQUIRED_RUNTIME_SETTINGS.every(
      (key) => typeof env[key] === "string" && (env[key] as string).trim(),
    )
  )
    return;
  // stop() sends SIGTERM; the runtime drains persisted webhook deliveries.
  // Operators must observe stopped state before transferring writer ownership.
  await getContainer(env.LOGIN, "login").stop();
}

export class LoginContainer extends Container<Env> {
  defaultPort = 3200;
  sleepAfter = "30m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") values[key] = value;
    }
    for (const key of REQUIRED_RUNTIME_SETTINGS) {
      if (!values[key]?.trim())
        throw new Error(`Missing login setting: ${key}`);
    }
    this.envVars = {
      ...values,
      NODE_ENV: "production",
      LOGIN_BIND_HOST: "0.0.0.0",
      PORT: "3200",
      STEWARD_TRUSTED_PROXY_HOPS: "1",
      STEWARD_TRUST_CLOUDFLARE: "false",
    };
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.LOGIN_ENABLED !== "true") {
      await stopInactiveRuntime(env);
      return;
    }
    // Keep the existing runtime scheduler alive to retry persisted webhook
    // deliveries even when the login API receives no foreground traffic.
    const response = await getContainer(env.LOGIN, "login").fetch(
      "http://login/health",
    );
    if (!response.ok)
      throw new Error(`Login readiness failed (${response.status})`);
    await response.body?.cancel();
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const aggregation = path.startsWith("/internal/aggregation/");
    const spendMetrics = path.startsWith("/internal/spend-metrics/");
    if (
      spendMetrics ||
      aggregation ||
      path.startsWith("/internal/rate-limit/")
    ) {
      const token = spendMetrics
        ? env.STEWARD_SPEND_METRICS_TOKEN
        : aggregation
          ? env.STEWARD_AGGREGATION_TOKEN
          : env.STEWARD_RATE_LIMIT_TOKEN;
      if (typeof token !== "string" || !token.trim()) {
        return new Response("State service unavailable", { status: 503 });
      }
      const expected = new TextEncoder().encode(`Bearer ${token.trim()}`);
      const actual = new TextEncoder().encode(
        request.headers.get("Authorization") ?? "",
      );
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (spendMetrics)
        return env.SPEND_METRICS.get(
          env.SPEND_METRICS.idFromName("login"),
        ).fetch(request);
      if (aggregation)
        return env.AGGREGATIONS.get(env.AGGREGATIONS.idFromName("login")).fetch(
          request,
        );
      return env.RATE_LIMITS.get(env.RATE_LIMITS.idFromName("login")).fetch(
        request,
      );
    }
    if (env.LOGIN_ENABLED !== "true") {
      await stopInactiveRuntime(env);
      return new Response("Login deployment inactive", { status: 503 });
    }
    const headers = new Headers(request.headers);
    // Trust the edge or a signed first-party proxy assertion, never a caller
    // forwarding chain. Cross-zone Worker fetches otherwise share one address.
    headers.delete("forwarded");
    headers.delete("x-real-ip");
    headers.delete("x-envoy-external-address");
    headers.delete("x-forwarded-for");
    const clientIp =
      verifiedProxyClientIp(request, env.STEWARD_REQUEST_SIGNING_SECRET) ??
      request.headers.get("CF-Connecting-IP");
    for (const name of [
      "x-steward-client-ip",
      "x-steward-client-ip-expires",
      "x-steward-client-ip-signature",
    ])
      headers.delete(name);
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    return getContainer(env.LOGIN, "login").fetch(
      new Request(request, { headers }),
    );
  },
};
