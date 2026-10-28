/** Verify a live gateway's selected settings without retrieving secret values. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { configurationDigest } from "../services/gateway-container/cloudflare/configuration-proof.ts";

export const CLOUDFLARE_WEBHOOK_GATEWAY_URLS: Readonly<Record<string, string>> =
  Object.freeze({
    staging:
      "https://eliza-gateway-webhook-staging.square-rain-7251.workers.dev",
    production:
      "https://eliza-gateway-webhook-production.square-rain-7251.workers.dev",
  });

export const CLOUDFLARE_DISCORD_GATEWAY_URLS: Readonly<Record<string, string>> =
  Object.freeze({
    staging:
      "https://eliza-gateway-discord-staging.square-rain-7251.workers.dev",
    production:
      "https://eliza-gateway-discord-production.square-rain-7251.workers.dev",
  });

export async function verifyCloudflareGatewayConfiguration(options: {
  environment: string;
  kind?: "webhook" | "discord";
  origin: string;
  bootstrapSecret: string;
  settings: Record<string, string>;
  sourceSha?: string;
  enabled?: boolean;
}): Promise<void> {
  const kind = options.kind ?? "webhook";
  const origins =
    kind === "discord"
      ? CLOUDFLARE_DISCORD_GATEWAY_URLS
      : CLOUDFLARE_WEBHOOK_GATEWAY_URLS;
  const canonical = Object.hasOwn(origins, options.environment)
    ? origins[options.environment]
    : undefined;
  if (!canonical || options.origin !== canonical) {
    throw new Error("Gateway origin does not match the protected environment");
  }
  if (!options.bootstrapSecret.trim()) {
    throw new Error(
      "Gateway configuration proof requires its bootstrap credential",
    );
  }
  const nonce = randomBytes(32).toString("hex");
  const names = Object.keys(options.settings).sort();
  const response = await fetch(`${canonical}/internal/configuration-proof`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${options.bootstrapSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ nonce, names }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Gateway configuration proof failed (HTTP ${response.status})`,
    );
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid gateway configuration proof response");
  }
  const proof = body as Record<string, unknown>;
  if (
    proof.environment !== options.environment ||
    proof.kind !== kind ||
    proof.enabled !== (options.enabled ?? true) ||
    typeof proof.sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(proof.sourceSha) ||
    (options.sourceSha !== undefined &&
      proof.sourceSha !== options.sourceSha) ||
    typeof proof.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.digest)
  ) {
    throw new Error(
      "Gateway configuration proof does not match the deployment",
    );
  }
  const actual = Buffer.from(proof.digest, "hex");
  const expected = Buffer.from(
    configurationDigest(nonce, names, options.settings),
    "hex",
  );
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(
      "Gateway configuration differs from the protected release settings",
    );
  }
}
