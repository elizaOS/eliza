/** Check the served API forwarding path without sending a provider message. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CLOUDFLARE_WEBHOOK_GATEWAY_URLS } from "./verify-cloudflare-gateway-configuration.ts";

export async function verifyServedWebhookGateway(
  environment: string,
): Promise<void> {
  if (environment !== "staging" && environment !== "production") {
    throw new Error(
      "Gateway routing verification requires staging or production",
    );
  }
  const gateway = CLOUDFLARE_WEBHOOK_GATEWAY_URLS[environment];
  const health = await fetch(`${gateway}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const source = health.headers.get("x-eliza-gateway-source");
  await health.body?.cancel();
  if (!health.ok || !source || !/^[a-f0-9]{40}$/.test(source)) {
    throw new Error("Cloudflare gateway health lacks a valid source marker");
  }
  const api =
    environment === "production"
      ? "https://api.eliza.app"
      : "https://api-staging.eliza.app";
  const url = new URL("/api/eliza-app/webhook/whatsapp", api);
  // This deliberately invalid handshake cannot subscribe a provider or send
  // a message. Its expected rejection proves both proxy hops are reachable.
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set(
    "hub.verify_token",
    `invalid-migration-probe-${randomUUID()}`,
  );
  url.searchParams.set("hub.challenge", randomUUID());
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  await response.body?.cancel();
  if (
    response.status !== 403 ||
    response.headers.get("x-eliza-gateway-host") !== "cloudflare" ||
    response.headers.get("x-eliza-gateway-environment") !== environment ||
    response.headers.get("x-eliza-gateway-source") !== source
  ) {
    throw new Error(
      "Served API does not reach the healthy Cloudflare gateway for this environment",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyServedWebhookGateway(process.env.DEPLOY_ENVIRONMENT ?? "");
  console.log(
    "Served API reaches the healthy Cloudflare gateway; invalid provider token rejected",
  );
}
