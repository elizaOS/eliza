/** Hosts the unchanged login runtime in a Cloudflare Container behind the Cloudflare edge. */

import { timingSafeEqual } from "node:crypto";
import { Container, getContainer } from "@cloudflare/containers";
import { LoginAggregations } from "./aggregation";
import { LoginRateLimits } from "./rate-limit";

export { LoginAggregations, LoginRateLimits };

interface Env {
  LOGIN: DurableObjectNamespace<LoginContainer>;
  AGGREGATIONS: DurableObjectNamespace<LoginAggregations>;
  RATE_LIMITS: DurableObjectNamespace<LoginRateLimits>;
  /** Deployment-owned settings and secrets. Never derived from a request. */
  [key: string]: unknown;
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
    for (const key of [
      "DATABASE_URL",
      "STEWARD_MASTER_PASSWORD",
      "STEWARD_JWT_SECRET",
      "STEWARD_KDF_SALT",
      "STEWARD_AUDIT_HMAC_KEY",
    ]) {
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
    if (aggregation || path.startsWith("/internal/rate-limit/")) {
      const token = aggregation
        ? env.STEWARD_AGGREGATION_TOKEN
        : env.STEWARD_RATE_LIMIT_TOKEN;
      if (typeof token !== "string" || !token.trim()) {
        return new Response("Rate limits unavailable", { status: 503 });
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
      if (aggregation)
        return env.AGGREGATIONS.get(env.AGGREGATIONS.idFromName("login")).fetch(
          request,
        );
      return env.RATE_LIMITS.get(env.RATE_LIMITS.idFromName("login")).fetch(
        request,
      );
    }
    const headers = new Headers(request.headers);
    // Only the Cloudflare edge may supply client network identity. Never pass
    // a caller-controlled forwarding chain into the login abuse limiter.
    headers.delete("forwarded");
    headers.delete("x-real-ip");
    headers.delete("x-envoy-external-address");
    headers.delete("x-forwarded-for");
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    return getContainer(env.LOGIN, "login").fetch(
      new Request(request, { headers }),
    );
  },
};
