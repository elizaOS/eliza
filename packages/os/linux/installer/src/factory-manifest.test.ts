import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELEASE_PUBLIC_KEY_ENV,
  RELEASE_PUBLIC_KEY_FINGERPRINT_ENV,
  RELEASE_REVOKED_KEY_FINGERPRINTS_ENV,
} from "../../../usb-installer/src/backend/ed25519-trust";
import {
  FactoryManifestError,
  verifyFactoryManifest,
} from "./factory-manifest";

const keys = generateKeyPairSync("ed25519");
const publicDer = keys.publicKey.export({ type: "spki", format: "der" });
const fingerprint = createHash("sha256").update(publicDer).digest("hex");
const policy = {
  publicKey: keys.publicKey,
  architecture: "x86_64" as const,
  minimumSequence: 10,
  now: new Date("2026-09-24T00:00:00.000Z"),
};
const manifest = {
  schemaVersion: 1,
  product: "elizaOS",
  architecture: "x86_64",
  version: "1.0.0",
  sequence: 10,
  expires: "2026-10-24T00:00:00.000Z",
  recovery: { sha256: "ab".repeat(32), sizeBytes: 8 * 1024 ** 3 },
  esp: { sha256: "cd".repeat(32), sizeBytes: 768 * 1024 ** 2 },
  boot: {
    kernelArguments: ["console=tty0"],
    kernelPath: "/elizaos/vmlinuz",
    initrdPaths: ["/elizaos/microcode.initrd", "/elizaos/initrd"],
    recoveryKernelPath: "/elizaos-recovery/vmlinuz",
    recoveryInitrdPaths: ["/elizaos-recovery/initrd"],
  },
};
function signed(value: unknown = manifest) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, signature: sign(null, bytes, keys.privateKey) };
}
function verify(value: unknown) {
  const { bytes, signature } = signed(value);
  return verifyFactoryManifest(bytes, signature, policy);
}

afterEach(() => vi.unstubAllEnvs());

describe("signed factory metadata", () => {
  it("binds exact bytes to the publisher key and preserves all boot inputs", () => {
    const { bytes, signature } = signed();
    const result = verifyFactoryManifest(bytes, signature, policy);
    expect(result.manifest).toEqual(manifest);
    expect(result.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.releaseKeyFingerprint).toBe(fingerprint);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.recovery)).toBe(true);
    expect(Object.isFrozen(result.manifest.boot)).toBe(true);
    expect(Object.isFrozen(result.manifest.boot.initrdPaths)).toBe(true);
    bytes.fill(0);
    expect(result.manifest.boot.initrdPaths).toEqual(manifest.boot.initrdPaths);
  });

  it("rejects altered bytes, wrong signatures, and unrelated publisher keys", () => {
    const { bytes, signature } = signed();
    expect(() =>
      verifyFactoryManifest(
        Buffer.concat([bytes, Buffer.from(" ")]),
        signature,
        policy,
      ),
    ).toThrow(FactoryManifestError);
    expect(() =>
      verifyFactoryManifest(bytes, Buffer.alloc(64), policy),
    ).toThrow(FactoryManifestError);
    expect(() =>
      verifyFactoryManifest(bytes, signature, {
        ...policy,
        publicKey: generateKeyPairSync("ed25519").publicKey,
      }),
    ).toThrow(FactoryManifestError);
  });

  it("rejects signed expired, rolled-back, and incompatible releases", () => {
    for (const overrides of [
      { sequence: 9 },
      { sequence: 1.5 },
      { expires: policy.now.toISOString() },
      { expires: "invalid" },
      { architecture: "arm64" },
      { product: "other" },
    ]) {
      expect(() => verify({ ...manifest, ...overrides })).toThrow(
        /incompatible, expired, or older/,
      );
    }
  });

  it("rejects unsupported fields and unsafe image or boot metadata even when signed", () => {
    for (const value of [
      { ...manifest, sourcePath: "/dev/sda" },
      {
        ...manifest,
        recovery: { ...manifest.recovery, sha256: "0".repeat(64) },
      },
      { ...manifest, esp: { ...manifest.esp, sizeBytes: 1 } },
      { ...manifest, boot: { ...manifest.boot, kernelPath: "/../kernel" } },
      {
        ...manifest,
        boot: { ...manifest.boot, kernelArguments: ["root=LABEL=usb"] },
      },
      { ...manifest, boot: { ...manifest.boot, initrdPaths: [] } },
    ])
      expect(() => verify(value)).toThrow(FactoryManifestError);
  });

  it("rejects invalid trusted policy and excessive inputs explicitly", () => {
    const { bytes, signature } = signed();
    for (const override of [
      { minimumSequence: 0 },
      { now: new Date(Number.NaN) },
    ]) {
      expect(() =>
        verifyFactoryManifest(bytes, signature, { ...policy, ...override }),
      ).toThrow(FactoryManifestError);
    }
    expect(() =>
      verifyFactoryManifest(Buffer.alloc(1024 * 1024 + 1), signature, policy),
    ).toThrow(/bounds/);
    expect(() =>
      verifyFactoryManifest(bytes, Buffer.alloc(1025), policy),
    ).toThrow(/bounds/);
  });

  it("uses the USB writer's pinned and revoked release-key policy by default", () => {
    const { bytes, signature } = signed();
    vi.stubEnv(RELEASE_PUBLIC_KEY_ENV, publicDer.toString("base64"));
    vi.stubEnv(RELEASE_PUBLIC_KEY_FINGERPRINT_ENV, fingerprint);
    vi.stubEnv(RELEASE_REVOKED_KEY_FINGERPRINTS_ENV, "");
    const { publicKey: _key, ...pinnedPolicy } = policy;
    expect(
      verifyFactoryManifest(bytes, signature, pinnedPolicy)
        .releaseKeyFingerprint,
    ).toBe(fingerprint);
    vi.stubEnv(RELEASE_REVOKED_KEY_FINGERPRINTS_ENV, fingerprint);
    expect(() => verifyFactoryManifest(bytes, signature, pinnedPolicy)).toThrow(
      FactoryManifestError,
    );
  });
});
