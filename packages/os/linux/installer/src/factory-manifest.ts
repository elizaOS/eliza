import { createHash, type KeyObject } from "node:crypto";
import {
  assertEd25519Signature,
  loadPinnedEd25519PublicKey,
  publicKeyFingerprint,
} from "../../../usb-installer/src/backend/ed25519-trust";
import { assertFactoryBootLayout, type FactoryBootLayout } from "./boot-config";

interface FactoryImageReference {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface FactoryManifest {
  schemaVersion: 1;
  product: "elizaOS";
  architecture: FactoryBootLayout["architecture"];
  version: string;
  sequence: number;
  expires: string;
  recovery: FactoryImageReference;
  esp: FactoryImageReference;
  boot: Omit<FactoryBootLayout, "architecture">;
}

export interface FactoryManifestPolicy {
  architecture: FactoryBootLayout["architecture"];
  /** Highest accepted sequence from the existing durable release policy. */
  minimumSequence: number;
  publicKey?: KeyObject;
  now?: Date;
}

export class FactoryManifestError extends Error {
  readonly code = "ELIZAOS_FACTORY_MANIFEST_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FactoryManifestError";
  }
}

function exact(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new FactoryManifestError(
      "Factory manifest contains missing or unsupported fields.",
    );
  }
}

function image(value: unknown): FactoryImageReference {
  exact(value, ["sha256", "sizeBytes"]);
  if (
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.sha256 === "0".repeat(64) ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 32 * 1024 ** 2 ||
    value.sizeBytes % 4096 !== 0
  ) {
    throw new FactoryManifestError(
      "Factory image reference has an invalid digest or size.",
    );
  }
  return { sha256: value.sha256, sizeBytes: value.sizeBytes };
}

/** Verify exact signed bytes before decoding source metadata. Device paths and
 * storage policy never come from the manifest. This performs no I/O and does
 * not claim that referenced images have already been staged or checked. */
export function verifyFactoryManifest(
  bytes: Uint8Array,
  signature: Uint8Array,
  policy: FactoryManifestPolicy,
): Readonly<{
  manifest: Readonly<FactoryManifest>;
  sha256: string;
  releaseKeyFingerprint: string;
}> {
  try {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > 1024 * 1024 ||
      signature.byteLength === 0 ||
      signature.byteLength > 1024 ||
      !["x86_64", "arm64"].includes(policy.architecture) ||
      !Number.isSafeInteger(policy.minimumSequence) ||
      policy.minimumSequence < 1
    ) {
      throw new FactoryManifestError(
        "Factory manifest exceeds its bounds or has an invalid trusted policy.",
      );
    }
    const now = (policy.now ?? new Date()).getTime();
    if (!Number.isFinite(now))
      throw new FactoryManifestError(
        "Factory manifest policy has an invalid clock.",
      );
    const payload = Buffer.from(bytes);
    const detachedSignature = Buffer.from(signature);
    const key = policy.publicKey ?? loadPinnedEd25519PublicKey();
    assertEd25519Signature(payload, detachedSignature, key, "Factory manifest");
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    );
    exact(value, [
      "schemaVersion",
      "product",
      "architecture",
      "version",
      "sequence",
      "expires",
      "recovery",
      "esp",
      "boot",
    ]);
    if (
      value.schemaVersion !== 1 ||
      value.product !== "elizaOS" ||
      value.architecture !== policy.architecture ||
      typeof value.version !== "string" ||
      !/^[a-zA-Z0-9._+-]{1,128}$/.test(value.version) ||
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < policy.minimumSequence ||
      typeof value.expires !== "string" ||
      !Number.isFinite(Date.parse(value.expires)) ||
      new Date(value.expires).toISOString() !== value.expires ||
      Date.parse(value.expires) <= now
    ) {
      throw new FactoryManifestError(
        "Factory manifest is incompatible, expired, or older than the accepted release sequence.",
      );
    }
    const recovery = image(value.recovery);
    const esp = image(value.esp);
    exact(value.boot, [
      "kernelArguments",
      "kernelPath",
      "initrdPaths",
      "recoveryKernelPath",
      "recoveryInitrdPaths",
    ]);
    const layout = { ...value.boot, architecture: value.architecture };
    assertFactoryBootLayout(layout);
    const { architecture, ...boot } = layout;
    const manifest: FactoryManifest = {
      schemaVersion: 1,
      product: "elizaOS",
      architecture,
      version: value.version,
      sequence: value.sequence,
      expires: value.expires,
      recovery,
      esp,
      boot,
    };
    Object.freeze(recovery);
    Object.freeze(esp);
    Object.freeze(boot.kernelArguments);
    Object.freeze(boot.initrdPaths);
    Object.freeze(boot.recoveryInitrdPaths);
    Object.freeze(boot);
    return Object.freeze({
      manifest: Object.freeze(manifest),
      sha256: createHash("sha256").update(payload).digest("hex"),
      releaseKeyFingerprint: publicKeyFingerprint(key),
    });
  } catch (error) {
    if (error instanceof FactoryManifestError) throw error;
    throw new FactoryManifestError(
      "Factory manifest authentication or decoding failed.",
      { cause: error },
    );
  }
}
