import assert from "node:assert/strict";
import test from "node:test";
import {
  configurationDigest,
  configurationProof,
} from "../services/gateway-container/cloudflare/configuration-proof.ts";
import {
  CLOUDFLARE_DISCORD_GATEWAY_URLS,
  CLOUDFLARE_WEBHOOK_GATEWAY_URLS,
  verifyCloudflareGatewayConfiguration,
} from "./verify-cloudflare-gateway-configuration.ts";
import { verifyDiscordGatewayBinding } from "./verify-discord-gateway-binding.ts";
import { verifyServedWebhookGateway } from "./verify-served-webhook-gateway.ts";

const options = {
  environment: "staging",
  origin: CLOUDFLARE_DISCORD_GATEWAY_URLS.staging,
  bootstrapSecret: "fixture-bootstrap",
  internalSecret: "fixture-delivery",
};

for (const scenario of [
  "cloudflare",
  "stopped-railway",
  "running-railway",
  "wrong-environment",
  "different-image",
]) {
  test(`served webhook routing verifies destination: ${scenario}`, async (t) => {
    let calls = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL, init: RequestInit) => {
        calls++;
        assert.equal(init.redirect, "error");
        const headers = new Headers({
          "x-eliza-gateway-host": "cloudflare",
          "x-eliza-gateway-environment": "staging",
          "x-eliza-gateway-source": "a".repeat(40),
        });
        if (calls === 1) {
          assert.equal(
            String(input),
            `${CLOUDFLARE_WEBHOOK_GATEWAY_URLS.staging}/health`,
          );
          return new Response("healthy", { headers });
        }
        const url = new URL(input);
        assert.equal(url.origin, "https://api-staging.eliza.app");
        assert.equal(url.pathname, "/api/eliza-app/webhook/whatsapp");
        assert.match(
          url.searchParams.get("hub.verify_token") ?? "",
          /^invalid-migration-probe-/,
        );
        if (scenario.endsWith("railway"))
          headers.delete("x-eliza-gateway-host");
        if (scenario === "wrong-environment")
          headers.set("x-eliza-gateway-environment", "production");
        if (scenario === "different-image")
          headers.set("x-eliza-gateway-source", "b".repeat(40));
        return new Response("Forbidden", {
          status: scenario === "stopped-railway" ? 404 : 403,
          headers,
        });
      },
    );
    if (scenario === "cloudflare") await verifyServedWebhookGateway("staging");
    else await assert.rejects(verifyServedWebhookGateway("staging"));
    assert.equal(calls, 2);
  });
}

test("Discord cutover verifies the selected delivery credential with a fresh authenticated nonce", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, `${options.origin}/internal/configuration-proof`);
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer fixture-bootstrap",
    );
    assert.equal(init.redirect, "error");
    const body = JSON.parse(String(init.body));
    assert.match(body.nonce, /^[a-f0-9]{64}$/);
    assert.deepEqual(body.names, ["GATEWAY_INTERNAL_SECRET"]);
    return configurationProof(new Request(url, init), {
      DEPLOYMENT_ENV: "staging",
      GATEWAY_KIND: "discord",
      GATEWAY_ENABLED: "true",
      BUILD_ID: "a".repeat(40),
      GATEWAY_RUNTIME_CONFIG: JSON.stringify({
        GATEWAY_BOOTSTRAP_SECRET: options.bootstrapSecret,
        GATEWAY_INTERNAL_SECRET: options.internalSecret,
      }),
    });
  });
  await verifyDiscordGatewayBinding(options);
  assert.equal(calls, 1);
});

for (const failure of [
  "wrong-kind",
  "inactive",
  "wrong-secret",
  "wrong-environment",
]) {
  test(`Discord cutover rejects ${failure}`, async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return Response.json({
          environment:
            failure === "wrong-environment" ? "production" : "staging",
          kind: failure === "wrong-kind" ? "webhook" : "discord",
          enabled: failure !== "inactive",
          sourceSha: "a".repeat(40),
          digest: configurationDigest(body.nonce, body.names, {
            GATEWAY_INTERNAL_SECRET:
              failure === "wrong-secret" ? "different" : options.internalSecret,
          }),
        });
      },
    );
    await assert.rejects(verifyDiscordGatewayBinding(options));
  });
}

test("invalid destinations and missing delivery credentials are rejected before egress", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected egress");
  });
  for (const origin of [
    CLOUDFLARE_DISCORD_GATEWAY_URLS.production,
    CLOUDFLARE_WEBHOOK_GATEWAY_URLS.staging,
    `${options.origin}/`,
    "https://untrusted.invalid",
  ])
    await assert.rejects(verifyDiscordGatewayBinding({ ...options, origin }));
  await assert.rejects(
    verifyDiscordGatewayBinding({ ...options, internalSecret: "" }),
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("existing webhook proofs retain their kind and environment checks", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({
        environment: "staging",
        kind: "webhook",
        enabled: true,
        sourceSha: "b".repeat(40),
        digest: configurationDigest(body.nonce, body.names, {
          forwarder: "fixture",
        }),
      });
    },
  );
  await verifyCloudflareGatewayConfiguration({
    environment: "staging",
    origin: CLOUDFLARE_WEBHOOK_GATEWAY_URLS.staging,
    bootstrapSecret: "fixture-bootstrap",
    settings: { forwarder: "fixture" },
  });
});
