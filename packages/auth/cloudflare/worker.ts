/** Hosts the unchanged login runtime in a Cloudflare Container behind the Cloudflare edge. */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  LOGIN: DurableObjectNamespace<LoginContainer>;
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
