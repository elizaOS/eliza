/** Actual Worker/DO storage regression. Root must supply the newly built, qualified artifact. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-identity";
import type { ApprovedRelayPhoto } from "@elizaos/plugin-network/contract";
import { svcSign } from "@elizaos/plugin-network/svc-auth";
import { Miniflare } from "miniflare";

const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const agentId = personalSharedAgentId({ userId, organizationId });
const activeKey = "network-delivery-active";
const config = Bun.TOML.parse(
  await readFile(new URL("../../wrangler.toml", import.meta.url), "utf8"),
) as {
  env: {
    production: {
      durable_objects: {
        bindings: Array<{ name: string; class_name: string }>;
      };
    };
  };
  exports: Record<string, { type: string; storage: string }>;
};
// Link whatever Durable Object classes and production bindings wrangler.toml
// declares; this test exercises only SharedRuntimeConversation storage, so it
// must not pin the DO inventory.
const classes = Object.keys(config.exports)
  .filter((name) => config.exports[name]?.type === "durable-object")
  .sort();
const normalBindings = config.env.production.durable_objects.bindings;

test("production DO bindings link to declared DO exports", () => {
  expect(classes).toContain("SharedRuntimeConversation");
  expect(
    normalBindings.some(
      (binding) =>
        binding.name === "SHARED_RUNTIME_CONVERSATIONS" &&
        binding.class_name === "SharedRuntimeConversation",
    ),
  ).toBe(true);
  for (const binding of normalBindings) {
    expect(classes).toContain(binding.class_name);
  }
});

for (const mode of [
  "prepared",
  "prepared-other-owner",
  "prepared-dispatch-marker",
  "dispatching",
  "unknown",
] as const) {
  test(`native closed photo relay settles only owned unsent prepared intent: ${mode}`, async () => {
    const path = process.env.ELIZA_QA_WORKER_MODULE;
    const expectedHash = process.env.ELIZA_QA_WORKER_SHA256;
    if (!path || !expectedHash)
      throw new Error(
        "Exact newly qualified photo Worker path/hash required; no skip or source alias",
      );
    const worker = await readFile(path);
    expect(sha(worker)).toBe(expectedHash);
    const now = Date.now();
    const photo: ApprovedRelayPhoto = {
      version: 1,
      app: "slop",
      itemId: "pri_" + "a".repeat(32),
      threadId: "thread-1",
      senderMemberId: "sender",
      recipientMemberId: "recipient",
      photoId: "ph_" + "a".repeat(24),
      sha256: "a".repeat(64),
      bytes: 100,
      contentType: "image/jpeg",
      consentId: "consent-1",
      consentedAt: now - 1000,
      reviewId: "review-1",
      reviewedAt: now - 500,
      policyVersion: "controlled-closed-policy",
      expiresAt: now + 60000,
    };
    const delivery = {
      project: "eliza-app",
      connectorAccountId: "owned-line",
      app: "slop",
      userId,
      organizationId,
      phoneNumber: "+15555550101",
      platform: "blooio",
      idempotencyKey: `network:svc:relay:${photo.itemId}`,
      text: "Ari sent you a photo.",
      approvedPhotos: [photo],
    };
    const policy = {
      phoneNumber: delivery.phoneNumber,
      project: "eliza-app",
      platform: "blooio",
      connectorAccountId: delivery.connectorAccountId,
      messageIdPrefix: "blooio:eliza-app:",
      userId,
      organizationId,
    };
    const serviceSecret = "controlled-photo-receipt-key-".repeat(3);
    const originalBody = JSON.stringify({
      id: delivery.idempotencyKey.slice("network:svc:".length),
      to: delivery.phoneNumber,
      text: delivery.text,
      app: delivery.app,
      memberId: photo.recipientMemberId,
      kind: "relay",
      approvedPhotos: [photo],
    });
    const servicePath = "/api/internal/network/deliver/receipt";
    const trustedNetworkServiceDelivery = {
      originalBody,
      path: servicePath,
      signatureHeaders: await svcSign(serviceSecret, {
        method: "POST",
        path: servicePath,
        id: delivery.idempotencyKey.slice("network:svc:".length),
        body: originalBody,
      }),
    };
    const key = "network-delivery:" + sha(delivery.idempotencyKey);
    const hash = sha(
      JSON.stringify([
        agentId,
        delivery.project,
        delivery.app,
        userId,
        organizationId,
        delivery.phoneNumber,
        delivery.platform,
        delivery.idempotencyKey,
        delivery.text,
        null,
        null,
        null,
        delivery.connectorAccountId,
        null,
        ["approved-photos", [photo]],
      ]),
    );
    const prepared = mode.startsWith("prepared");
    const intent = {
      hash,
      providerKey: "network:personal:photo-fixture",
      state: prepared ? "prepared" : mode,
      delivery,
      ...(!prepared || mode === "prepared-dispatch-marker"
        ? { dispatchedAt: now }
        : {}),
    };
    const other = "network-delivery:other-owned-intent";
    const retryAt = now + 60000,
      idleAt = now + 600000;
    const wrapperPath = join(dirname(path), "qa-native-photo-wrapper.mjs");
    const calls: string[] = [];
    const wrapper = `import { SharedRuntimeConversation } from "./qualified-photo-api.mjs";
export { ${classes.join(", ")} } from "./qualified-photo-api.mjs";
export class NativePhotoRoom extends SharedRuntimeConversation {
 constructor(state, env) { super(state, env); this.fixtureState = state; }
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if(path === "/__fixture/seed") { await this.fixtureState.storage.put(await request.json()); return Response.json({ok:true}); }
  if(path === "/__fixture/read") { return Response.json(Object.fromEntries(await this.fixtureState.storage.get(await request.json()))); }
  return super.fetch(request);
 }
}
export default { fetch() { return new Response("No public fixture route", {status:404}); } };`;
    const mf = new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [
        { type: "ESModule", path: wrapperPath, contents: wrapper },
        {
          type: "ESModule",
          path: join(dirname(path), "qualified-photo-api.mjs"),
          contents: worker.toString(),
        },
      ],
      // Link all normal namespace/class declarations to this same actual module.
      // Only Shared uses the existing storage-fixture subclass; other classes
      // are linked, not exercised as product operations.
      durableObjects: Object.fromEntries(
        normalBindings.map((binding) => [
          binding.name,
          {
            className:
              binding.class_name === "SharedRuntimeConversation"
                ? "NativePhotoRoom"
                : binding.class_name,
            useSQLite: config.exports[binding.class_name]?.storage === "sqlite",
          },
        ]),
      ),

      bindings: {
        NETWORK_PERSONAL_CONTINUITY_ENABLED: "true",
        NETWORK_RELAY_ENABLED: "0",
        ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.invalid",
        GATEWAY_INTERNAL_SECRET: "controlled-private-gateway",
        SERVICE_TURN_SECRET: serviceSecret,
        NETWORK_OWNED_INGRESS_POLICY: JSON.stringify(policy),
      },
      outboundService: async (request: { url: string }) => {
        calls.push(new URL(request.url).pathname);
        expect(new URL(request.url).pathname).toBe("/internal/deliver/receipt");
        return Response.json(
          { success: false, acceptance: "unknown", retryable: false },
          { status: 202 },
        );
      },
    });
    try {
      const namespace = await mf.getDurableObjectNamespace(
        "SHARED_RUNTIME_CONVERSATIONS",
      );
      const stub = namespace.get(namespace.idFromName(`${agentId}:${agentId}`));
      await (
        await stub.fetch("https://fixture.invalid/__fixture/seed", {
          method: "POST",
          body: JSON.stringify({
            [key]: intent,
            [activeKey]: mode === "prepared-other-owner" ? other : key,
            "alarm-deadlines": {
              networkDeliveryRetryAt: retryAt,
              idleExpiryAt: idleAt,
            },
          }),
        })
      ).text();
      const response = await stub.fetch(
        "https://fixture.invalid/network-delivery",
        {
          method: "POST",
          body: JSON.stringify({
            operation: "network-delivery",
            agentId,
            roomId: agentId,
            delivery,
            trustedNetworkServiceDelivery,
            reconcileOnly: true,
          }),
        },
      );
      expect(response.status).toBe(
        mode === "prepared" || mode === "prepared-other-owner" ? 403 : 202,
      );
      const persisted: unknown = await (
        await stub.fetch("https://fixture.invalid/__fixture/read", {
          method: "POST",
          body: JSON.stringify([key, activeKey, "alarm-deadlines"]),
        })
      ).json();
      if (!persisted || typeof persisted !== "object")
        throw new Error("Expected fixture storage record");
      const record = persisted as Record<string, unknown>;
      if (mode === "prepared" || mode === "prepared-other-owner") {
        expect(record[key]).toMatchObject({
          state: "rejected",
          refusal: { error: "rejected", retryable: false },
          hash,
          providerKey: intent.providerKey,
        });
        expect(calls).toEqual([]);
        if (mode === "prepared") {
          expect(record[activeKey]).toBeUndefined();
          expect(record["alarm-deadlines"]).toEqual({ idleExpiryAt: idleAt });
        } else {
          expect(record[activeKey]).toBe(other);
          expect(record["alarm-deadlines"]).toEqual({
            networkDeliveryRetryAt: retryAt,
            idleExpiryAt: idleAt,
          });
        }
      } else {
        expect(record[key]).toMatchObject({
          state: mode === "prepared-dispatch-marker" ? "prepared" : "unknown",
          hash,
        });
        expect(record[activeKey]).toBe(key);
        expect(calls).toEqual(
          mode === "prepared-dispatch-marker"
            ? []
            : ["/internal/deliver/receipt"],
        );
      }
    } finally {
      await mf.dispose();
    }
  });
}
