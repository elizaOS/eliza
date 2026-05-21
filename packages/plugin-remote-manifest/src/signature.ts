/**
 * Plugin tarball signature verification (SOC2 A-1).
 *
 * Every artifact-sourced remote plugin must carry a SHA-256 hash and an
 * Ed25519 signature over that hash. Installation is gated on:
 *
 *   1. The computed SHA-256 of the tarball matching the declared `currentHash`.
 *   2. The Ed25519 signature verifying against `system:plugin-manifest/v1`
 *      via `KmsClient.verify`.
 *
 * Both checks are mandatory. Failure rejects the install and (when a
 * dispatcher is supplied) emits `plugin.install` with `result: "failure"`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuditDispatcher } from "@elizaos/security";
import type { KmsClient } from "@elizaos/security";
import { systemKey } from "@elizaos/security";

export const PLUGIN_MANIFEST_KEY = systemKey("plugin-manifest");

export interface PluginSignaturePayload {
  /** Lower-case hex SHA-256 of the tarball. */
  hash: string;
  /** Base64 Ed25519 signature over the raw hash bytes. */
  signature: string;
  /** Optional human-readable signer label; not trusted, audit-only. */
  signer?: string;
}

export interface VerifyPluginArtifactInput {
  pluginId: string;
  version: string;
  tarballPath: string;
  /** Manifest-declared signature payload. */
  signature: PluginSignaturePayload;
  kms: KmsClient;
  auditDispatcher?: AuditDispatcher;
  actorId?: string;
}

export class PluginSignatureError extends Error {
  constructor(
    message: string,
    readonly code:
      | "HASH_MISMATCH"
      | "BAD_SIGNATURE"
      | "MISSING_HASH"
      | "MISSING_SIGNATURE",
  ) {
    super(message);
    this.name = "PluginSignatureError";
  }
}

export async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new PluginSignatureError(`Malformed hex: ${hex}`, "HASH_MISMATCH");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify a plugin tarball against its declared signature.
 *
 * Throws `PluginSignatureError` and (when supplied) emits an audit
 * failure event on rejection. On success, emits a `plugin.install`
 * success event.
 */
export async function verifyPluginArtifact(
  input: VerifyPluginArtifactInput,
): Promise<void> {
  const { pluginId, version, signature, kms, auditDispatcher, actorId } = input;

  const emitFailure = async (reason: string): Promise<void> => {
    if (!auditDispatcher) return;
    await auditDispatcher.emit({
      actor: { type: actorId ? "user" : "system", id: actorId ?? "agent" },
      action: "plugin.install",
      result: "failure",
      resource: { type: "plugin", id: pluginId },
      metadata: { plugin_id: pluginId, version, reason },
    });
  };

  if (!signature.hash) {
    await emitFailure("missing_hash");
    throw new PluginSignatureError(
      `Plugin ${pluginId} missing required SHA-256 hash`,
      "MISSING_HASH",
    );
  }
  if (!signature.signature) {
    await emitFailure("missing_signature");
    throw new PluginSignatureError(
      `Plugin ${pluginId} missing required Ed25519 signature`,
      "MISSING_SIGNATURE",
    );
  }

  const expectedHash = signature.hash.toLowerCase();
  const actualHash = (await sha256File(input.tarballPath)).toLowerCase();
  if (expectedHash !== actualHash) {
    await emitFailure("hash_mismatch");
    throw new PluginSignatureError(
      `Plugin ${pluginId} hash mismatch: expected ${expectedHash}, got ${actualHash}`,
      "HASH_MISMATCH",
    );
  }

  const hashBytes = fromHex(actualHash);
  const sigBytes = fromBase64(signature.signature);
  const ok = await kms.verify(
    PLUGIN_MANIFEST_KEY,
    hashBytes,
    sigBytes,
    "ed25519",
  );
  if (!ok) {
    await emitFailure("bad_signature");
    throw new PluginSignatureError(
      `Plugin ${pluginId} Ed25519 signature verification failed`,
      "BAD_SIGNATURE",
    );
  }

  if (auditDispatcher) {
    await auditDispatcher.emit({
      actor: { type: actorId ? "user" : "system", id: actorId ?? "agent" },
      action: "plugin.install",
      result: "success",
      resource: { type: "plugin", id: pluginId },
      metadata: { plugin_id: pluginId, version },
    });
  }
}
