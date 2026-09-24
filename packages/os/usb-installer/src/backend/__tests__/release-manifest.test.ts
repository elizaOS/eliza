import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPinnedEd25519PublicKey } from "../ed25519-trust";
import { fetchReleaseImages, parseReleaseManifest } from "../release-manifest";
import {
  configuredReleaseSequenceStore,
  type ReleaseSequenceStore,
} from "../release-sequence-store";

const now = Date.parse("2026-08-17T00:00:00Z");
const artifact = {
  schemaVersion: 1 as const,
  product: "elizaOS" as const,
  version: "1.0.0",
  channel: "stable" as const,
  sequence: 42,
  expires: "2026-09-17T00:00:00Z",
  architecture: "x86_64" as const,
  url: "https://download.elizaos.ai/os/elizaos-1.0.0-x86_64.raw.zst",
  compressedSize: 4_000_000_000,
  expandedSize: 12_000_000_000,
  sha256Compressed: "0123456789abcdef".repeat(4),
  sha256Expanded: "fedcba9876543210".repeat(4),
  signatureUrl:
    "https://download.elizaos.ai/os/elizaos-1.0.0-x86_64.raw.zst.sig",
  minDeviceBytes: 32_000_000_000,
};
const manifest = (artifacts: unknown[]) => ({
  schemaVersion: 1 as const,
  product: "elizaOS" as const,
  artifacts,
});
const signingKeyPair = generateKeyPairSync("ed25519");
const signingPublicKeyDer = signingKeyPair.publicKey.export({
  format: "der",
  type: "spki",
});
const signingPublicKey = signingPublicKeyDer.toString("base64");
const signingPublicKeyFingerprint = createHash("sha256")
  .update(signingPublicKeyDer)
  .digest("hex");
const acceptingSequenceStore: ReleaseSequenceStore = {
  accept: async () => undefined,
};

function signedManifestFetcher(rawManifest: Uint8Array, tamper = false) {
  const signature = sign(null, rawManifest, signingKeyPair.privateKey);
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(".sig"))
      return new Response(Uint8Array.from(signature).buffer);
    const body = tamper ? new Uint8Array([...rawManifest, 0x20]) : rawManifest;
    return new Response(Uint8Array.from(body).buffer, {
      headers: { "content-length": String(body.byteLength) },
    });
  };
}

describe("canonical release manifest", () => {
  it("maps a signed, versioned raw.zst artifact without losing release fields", () => {
    expect(parseReleaseManifest(manifest([artifact]), now)).toEqual([
      expect.objectContaining({
        id: "elizaOS-1.0.0-x86_64-42",
        format: "raw.zst",
        sequence: 42,
        compressedSize: artifact.compressedSize,
        expandedSize: artifact.expandedSize,
        checksumSha256: artifact.sha256Compressed,
        sha256Expanded: artifact.sha256Expanded,
        minUsbSizeBytes: artifact.minDeviceBytes,
      }),
    ]);
  });

  it.each([
    ["expired", { expires: "2026-08-16T00:00:00Z" }],
    ["ISO artifact", { url: "https://download.elizaos.ai/elizaos.iso" }],
    ["placeholder digest", { sha256Compressed: "0".repeat(64) }],
    ["missing signature", { signatureUrl: undefined }],
    ["undersized device", { minDeviceBytes: 1 }],
    ["unknown field", { unsignedFallback: true }],
    ["non-semantic version", { version: "latest" }],
    ["non-canonical expiry", { expires: "September 17 2026" }],
    ["non-signature URL", { signatureUrl: "https://example.test/image.txt" }],
  ])("rejects %s metadata", (_label, override) => {
    expect(() =>
      parseReleaseManifest(manifest([{ ...artifact, ...override }]), now),
    ).toThrow("Invalid release artifact");
  });

  it("rejects ambiguous or extensible manifest envelopes", () => {
    expect(() => parseReleaseManifest([artifact], now)).toThrow(
      "must be an object",
    );
    expect(() =>
      parseReleaseManifest(
        { ...manifest([artifact]), unsignedFallback: true },
        now,
      ),
    ).toThrow("envelope is unsupported");
  });

  it("fails closed on HTTP errors, redirects, and non-HTTPS manifest URLs", async () => {
    await expect(
      fetchReleaseImages("http://example.test/manifest.json", fetch, now),
    ).rejects.toThrow("must be HTTPS");

    const failingFetch = async () => new Response("no", { status: 503 });
    const { publicKey } = generateKeyPairSync("ed25519");
    await expect(
      fetchReleaseImages(
        "https://example.test/manifest.json",
        failingFetch,
        now,
        {
          publicKey,
          signatureUrl: "https://example.test/manifest.json.sig",
          sequenceStore: acceptingSequenceStore,
        },
      ),
    ).rejects.toThrow("HTTP 503");
  });

  it("verifies exact manifest bytes before parsing", async () => {
    const raw = new TextEncoder().encode(JSON.stringify(manifest([artifact])));
    await expect(
      fetchReleaseImages(
        "https://example.test/manifest.json",
        signedManifestFetcher(raw),
        now,
        {
          publicKey: signingKeyPair.publicKey,
          sequenceStore: acceptingSequenceStore,
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ id: "elizaOS-1.0.0-x86_64-42" }),
    ]);

    await expect(
      fetchReleaseImages(
        "https://example.test/manifest.json",
        signedManifestFetcher(raw, true),
        now,
        {
          publicKey: signingKeyPair.publicKey,
          sequenceStore: acceptingSequenceStore,
        },
      ),
    ).rejects.toThrow("signature verification failed");
  });

  it("requires a production Ed25519 key and rejects other algorithms", () => {
    expect(() => loadPinnedEd25519PublicKey({})).toThrow(
      "Production release discovery is disabled",
    );
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    const encoded = rsa
      .export({ format: "der", type: "spki" })
      .toString("base64");
    expect(() =>
      loadPinnedEd25519PublicKey({
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: encoded,
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256: createHash("sha256")
          .update(Buffer.from(encoded, "base64"))
          .digest("hex"),
      }),
    ).toThrow("must be an Ed25519");
    expect(() =>
      loadPinnedEd25519PublicKey({
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: "AB==",
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256: "1".repeat(64),
      }),
    ).toThrow("canonical base64");
  });

  it("binds the release key to its independent pin and revocation policy", () => {
    const trusted = {
      ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: signingPublicKey,
      ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256:
        signingPublicKeyFingerprint,
    };
    expect(loadPinnedEd25519PublicKey(trusted)).toBeDefined();
    expect(() =>
      loadPinnedEd25519PublicKey({
        ...trusted,
        ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256: "1".repeat(64),
      }),
    ).toThrow("does not match the independently reviewed");
    expect(() =>
      loadPinnedEd25519PublicKey({
        ...trusted,
        ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S:
          signingPublicKeyFingerprint,
      }),
    ).toThrow("release key is revoked");
    expect(() =>
      loadPinnedEd25519PublicKey({
        ...trusted,
        ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S: `${signingPublicKeyFingerprint},${signingPublicKeyFingerprint}`,
      }),
    ).toThrow("sorted, unique");
  });

  it("requires explicit persistent rollback state", () => {
    expect(() => configuredReleaseSequenceStore({})).toThrow(
      "Release discovery is disabled",
    );
  });
});
