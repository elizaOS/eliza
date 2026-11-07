/** Real strict service-envelope/HMAC admission. No database, provider, model or image bytes. */
import { expect, test } from "bun:test";
import type { ApprovedRelayPhoto } from "@elizaos/plugin-network/contract";
import { svcSign } from "@elizaos/plugin-network/svc-auth";
import { verifyNetworkServiceDeliveryEnvelope } from "./network-shared-admission";

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
  bytes: 1234,
  contentType: "image/jpeg",
  consentId: "consent-1",
  consentedAt: now - 1000,
  reviewId: "review-1",
  reviewedAt: now - 500,
  policyVersion: "controlled-test-only",
  expiresAt: now + 30000,
};
const policy = {
  phoneNumber: "+15555550100",
  project: "eliza-app",
  platform: "blooio",
  connectorAccountId: "owned-connector",
  messageIdPrefix: "blooio:eliza-app:",
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
};
const secret = "controlled-approved-photo-service-".repeat(3);
const bindings = {
  SERVICE_TURN_SECRET: secret,
  NETWORK_PERSONAL_CONTINUITY_ENABLED: "true",
  NETWORK_RELAY_ENABLED: "1",
  NETWORK_OWNED_INGRESS_POLICY: JSON.stringify(policy),
};
async function signed(patch: Record<string, unknown> = {}, receipt = false) {
  const path = "/api/internal/network/deliver" + (receipt ? "/receipt" : "");
  const originalBody = JSON.stringify({
    id: `relay:${photo.itemId}`,
    to: policy.phoneNumber,
    text: "Ari sent you a photo.",
    app: "slop",
    memberId: "recipient",
    kind: "relay",
    approvedPhotos: [photo],
    ...patch,
  });
  return {
    path,
    originalBody,
    signatureHeaders: await svcSign(secret, {
      method: "POST",
      path,
      id: `relay:${photo.itemId}`,
      body: originalBody,
    }),
  };
}

test("approved photos require signed exact recipient/app and the existing relay switch", async () => {
  const envelope = await signed();
  expect(
    (await verifyNetworkServiceDeliveryEnvelope(envelope, bindings))?.delivery.approvedPhotos,
  ).toEqual([photo]);
  expect(
    await verifyNetworkServiceDeliveryEnvelope(envelope, {
      ...bindings,
      NETWORK_RELAY_ENABLED: "0",
    }),
  ).toBeUndefined();
  for (const patch of [
    { memberId: "other" },
    { app: "friends" },
    { channel: "twilio" },
    { kind: "reply" },
    { mediaUrls: ["https://untrusted.invalid/photo"] },
    { approvedPhotos: [{ ...photo, url: "https://untrusted.invalid/photo" }] },
  ]) {
    expect(
      await verifyNetworkServiceDeliveryEnvelope(await signed(patch), bindings),
    ).toBeUndefined();
  }
  // This public consumer has no QA route authority. An authority field must not fall back.
  expect(
    await verifyNetworkServiceDeliveryEnvelope(
      await signed({
        networkAuthority: {
          version: 1,
          routeId: "owned",
          generation: "g1",
          audience: "cloud",
          realmId: "closed",
        },
      }),
      bindings,
    ),
  ).toBeUndefined();
});

test("receipt recovery retains expired immutable identity after the relay flag closes", async () => {
  const expired = {
    ...photo,
    consentedAt: now - 20000,
    reviewedAt: now - 19000,
    expiresAt: now - 10000,
  };
  const envelope = await signed({ approvedPhotos: [expired] }, true);
  expect(
    (
      await verifyNetworkServiceDeliveryEnvelope(envelope, {
        ...bindings,
        NETWORK_RELAY_ENABLED: "0",
      })
    )?.delivery.approvedPhotos,
  ).toEqual([expired]);
  expect(
    await verifyNetworkServiceDeliveryEnvelope(
      {
        ...envelope,
        originalBody: envelope.originalBody.replace(photo.photoId, "ph_" + "b".repeat(24)),
      },
      bindings,
    ),
  ).toBeUndefined();
});
