import { createHash } from "node:crypto";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { buildRedisClient, type RedisFactoryEnvSource } from "../cache/redis-factory";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";

/** The atomic, expiring operations used by auth nonces and revocation markers. */
type AuthenticationStateWriteOptions = { ex: number; nx: true } | { ex: number; nx?: undefined };

export interface AuthenticationStateStore {
  get<T = unknown>(key: string): Promise<T | null>;
  getdel<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: string, options: AuthenticationStateWriteOptions): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
}

export class AuthenticationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationStateError";
  }
}

function authenticationStateShard(key: string): string {
  return `auth-v1:${createHash("sha256").update(key).digest("hex").slice(0, 2)}`;
}

/** Operator-only transfer through a private binding, before the target serves traffic. */
export async function importCloudflareAuthenticationState(
  namespace: RuntimeDurableObjectNamespace,
  entry: { key: string; value: string; expiresAt: number },
  sourceQuiesced: true,
): Promise<"imported" | "identical" | "expired"> {
  const response = await namespace
    .getByName(authenticationStateShard(entry.key))
    .fetch("https://authentication-state.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entry, operation: "import", sourceQuiesced }),
    });
  if (!response.ok)
    throw new AuthenticationStateError(`Authentication state import rejected (${response.status})`);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("status" in result) ||
    (result.status !== "imported" && result.status !== "identical" && result.status !== "expired")
  ) {
    throw new AuthenticationStateError("Invalid authentication state import receipt");
  }
  return result.status;
}

export class CloudflareAuthenticationState implements AuthenticationStateStore {
  constructor(private readonly namespace: RuntimeDurableObjectNamespace) {}

  private async request(
    key: string,
    operation: "get" | "getdel" | "set",
    value?: string,
    seconds?: number,
    nx?: boolean,
  ): Promise<string | null> {
    // All operations on a key reach the same strongly consistent owner.
    const response = await this.namespace
      .getByName(authenticationStateShard(key))
      .fetch("https://authentication-state.internal/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, operation, value, seconds, nx }),
      });
    if (!response.ok) {
      throw new AuthenticationStateError(`Authentication state failed (${response.status})`);
    }
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("value" in result) ||
      (result.value !== null && typeof result.value !== "string")
    ) {
      throw new AuthenticationStateError("Invalid authentication state response");
    }
    if (operation === "set" && result.value !== "OK" && result.value !== null) {
      throw new AuthenticationStateError("Invalid authentication write acknowledgement");
    }
    return result.value;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (await this.request(key, "get")) as T | null;
  }

  async getdel<T = unknown>(key: string): Promise<T | null> {
    return (await this.request(key, "getdel")) as T | null;
  }

  set(
    key: string,
    value: string,
    options: AuthenticationStateWriteOptions,
  ): Promise<string | null> {
    return this.request(key, "set", value, options.ex, options.nx);
  }

  setex(key: string, seconds: number, value: string): Promise<string | null> {
    return this.set(key, value, { ex: seconds });
  }
}

export function buildAuthenticationState(
  env: RedisFactoryEnvSource & { CLOUD_AUTH_STATE_BACKEND?: string } = getCloudAwareEnv(),
  namespace = getCloudBinding<RuntimeDurableObjectNamespace>("AUTHENTICATION_STATE"),
): AuthenticationStateStore | null {
  const backend = env.CLOUD_AUTH_STATE_BACKEND ?? "redis";
  if (backend === "redis") return buildRedisClient(env);
  if (backend !== "cloudflare") {
    throw new AuthenticationStateError("Invalid CLOUD_AUTH_STATE_BACKEND");
  }
  if (!namespace) {
    throw new AuthenticationStateError("AUTHENTICATION_STATE binding is required");
  }
  return new CloudflareAuthenticationState(namespace);
}
