import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApprovedRelayPhoto,
  parseApprovedRelayPhotos,
  parseNetworkRouteAuthorityV1,
  RELAY_PHOTO_RESOLVE_PATH,
} from "./contract.ts";

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
  consentedAt: 1000,
  reviewId: "review-1",
  reviewedAt: 2000,
  policyVersion: "closed-test",
  expiresAt: 10000,
};

test("approved photo identity normalizes JSON without accepting URLs or coercion", () => {
  assert.deepEqual(parseApprovedRelayPhotos([photo]), [photo]);
  const reversed = Object.fromEntries(Object.entries(photo).reverse());
  assert.equal(
    JSON.stringify(parseApprovedRelayPhotos([reversed])),
    JSON.stringify([photo]),
  );
  for (const patch of [
    { url: "https://untrusted.invalid/photo" },
    { appearanceScore: 9 },
    { version: 2 },
    { bytes: 0 },
    { bytes: 8 * 1024 * 1024 + 1 },
    { bytes: 1.5 },
    { contentType: "image/svg+xml" },
    { contentType: ["image/png"] },
    { contentType: { toString: null } },
    { photoId: "../private" },
    { sha256: "wrong" },
    { itemId: "../item" },
    { senderMemberId: "recipient" },
    { app: "unknown" },
    { reviewedAt: 999 },
    { expiresAt: 2000 },
    { expiresAt: 1000 + 15 * 60_000 + 1 },
    { consentedAt: 1.5 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(parseApprovedRelayPhotos([{ ...photo, ...patch }]), undefined);
  for (const value of [
    null,
    {},
    [],
    [null],
    [photo, photo],
    Array(4).fill(photo),
  ])
    assert.equal(parseApprovedRelayPhotos(value), undefined);
  assert.equal(RELAY_PHOTO_RESOLVE_PATH, "/internal/relay-photo/resolve");
});

test("one approval binds every selected photo to the same parties, item, consent and review", () => {
  const second = { ...photo, photoId: "ph_" + "b".repeat(24) };
  assert.deepEqual(parseApprovedRelayPhotos([photo, second]), [photo, second]);
  for (const patch of [
    { itemId: "other" },
    { threadId: "other" },
    { app: "ntwrk" },
    { senderMemberId: "other" },
    { recipientMemberId: "other" },
    { consentId: "other" },
    { consentedAt: 1500 },
    { reviewId: "other" },
    { reviewedAt: 2500 },
    { policyVersion: "other" },
    { expiresAt: 11000 },
  ])
    assert.equal(
      parseApprovedRelayPhotos([photo, { ...second, ...patch }]),
      undefined,
    );
  // An expired immutable identity remains recognizable for receipt-only recovery.
  // The caller must check current authority and expiry before a new send.
  assert.deepEqual(parseApprovedRelayPhotos([photo]), [photo]);
});

test("optional route authority is strictly structured without granting admission", () => {
  const authority = {
    version: 1,
    routeId: "route-1",
    generation: "g1",
    audience: "gateway",
    realmId: "realm-1",
  };
  const parsed = parseNetworkRouteAuthorityV1(authority);
  assert.deepEqual(parsed, authority);
  assert.equal(Object.isFrozen(parsed), true);
  for (const value of [
    null,
    [],
    {},
    { ...authority, version: 2 },
    { ...authority, routeId: "" },
    { ...authority, routeId: "https://untrusted.invalid" },
    { ...authority, generation: "x".repeat(65) },
    { ...authority, realmId: ["realm-1"] },
    { ...authority, audience: "x".repeat(129) },
    { ...authority, extra: true },
  ])
    assert.equal(parseNetworkRouteAuthorityV1(value), undefined);
  // Legacy absence is a structural result; only the receiving policy can admit it.
  assert.equal(parseNetworkRouteAuthorityV1(undefined), undefined);
});
