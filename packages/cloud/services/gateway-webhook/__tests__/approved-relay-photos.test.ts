import { expect, test } from "bun:test";
import type { ApprovedRelayPhoto } from "@elizaos/plugin-network/contract";
import { svcVerify } from "@elizaos/plugin-network/svc-auth";
import { resolveApprovedRelayPhotoUrls } from "../src/approved-relay-photos";

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
  policyVersion: "proposed-test-only",
  expiresAt: now + 60_000,
};
const env = {
  NETWORK_RELAY_ENABLED: "1",
  NETWORK_SERVICE_URL: "https://backend.invalid",
  SERVICE_TURN_SECRET: "synthetic-private-test-secret-".repeat(3),
};
const capability = `https://backend.invalid/api/relay-photos/deliver/${photo.itemId}?exp=${now + 30000}&sig=${"a".repeat(43)}`;
const result = (url = capability) => ({
  photos: [
    {
      photoId: photo.photoId,
      sha256: photo.sha256,
      bytes: photo.bytes,
      contentType: photo.contentType,
      url,
    },
  ],
});
const fixture = (
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch =>
  Object.assign(fn, {
    preconnect() {
      throw new Error("No fixture preconnect");
    },
  });

test("final resolver signs the exact immutable item/attempt/recipient on the trusted backend", async () => {
  let calls = 0;
  const fetcher = fixture(async (url, init) => {
    calls++;
    expect(String(url)).toBe(
      "https://backend.invalid/internal/relay-photo/resolve",
    );
    expect(init?.redirect).toBe("manual");
    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual({
      id: "network:personal:attempt",
      deliveryId: `relay:${photo.itemId}`,
      to: "+15555550101",
      approvedPhotos: [photo],
    });
    const proof = await svcVerify(env.SERVICE_TURN_SECRET, {
      method: "POST",
      path: "/internal/relay-photo/resolve",
      headers: new Headers(init?.headers),
      body,
    });
    expect(proof.ok).toBe(true);
    return Response.json(result());
  });
  expect(
    await resolveApprovedRelayPhotoUrls(
      [photo],
      "network:personal:attempt",
      "+15555550101",
      env,
      fetcher,
    ),
  ).toEqual([capability]);
  expect(calls).toBe(1);
});

test("closed flag and expired/review-future items never resolve, much less send", async () => {
  let calls = 0;
  const fetcher = fixture(async () => {
    calls++;
    throw new Error("must not fetch");
  });
  for (const [photos, flags] of [
    [[photo], { ...env, NETWORK_RELAY_ENABLED: "0" }],
    [[{ ...photo, expiresAt: now - 1, reviewedAt: now - 100 }], env],
    [[{ ...photo, reviewedAt: now + 5000 }], env],
  ] as const)
    await expect(
      resolveApprovedRelayPhotoUrls(
        [...photos],
        "attempt",
        "+15555550101",
        flags,
        fetcher,
      ),
    ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("gallery, foreign, credentialed and mismatched capabilities never reach the adapter", async () => {
  for (const url of [
    capability.replace("backend.invalid", "attacker.invalid"),
    capability.replace("/api/relay-photos/deliver/", "/api/photos/view/"),
    capability.replace(photo.itemId, "pri_" + "b".repeat(32)),
    capability + "&extra=model-input",
    capability.replace("https://", "https://user:secret@"),
    capability.replace(String(now + 30000), String(now + 120000)),
  ])
    await expect(
      resolveApprovedRelayPhotoUrls(
        [photo],
        "attempt",
        "+15555550101",
        env,
        fixture(async () => Response.json(result(url))),
      ),
    ).rejects.toThrow();
  const wrong = result();
  const wrongPhoto = wrong.photos[0];
  if (!wrongPhoto) throw new Error("Expected controlled resolved photo");
  wrongPhoto.sha256 = "b".repeat(64);
  await expect(
    resolveApprovedRelayPhotoUrls(
      [photo],
      "attempt",
      "+15555550101",
      env,
      fixture(async () => Response.json(wrong)),
    ),
  ).rejects.toThrow();
  await expect(
    resolveApprovedRelayPhotoUrls(
      [photo],
      "attempt",
      "+15555550101",
      env,
      fixture(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.invalid" },
          }),
      ),
    ),
  ).rejects.toThrow();
});
