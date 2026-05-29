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
import type { AuditDispatcher, KmsClient } from "@elizaos/security";
export declare const PLUGIN_MANIFEST_KEY: string;
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
export declare class PluginSignatureError extends Error {
    readonly code: "HASH_MISMATCH" | "BAD_SIGNATURE" | "MISSING_HASH" | "MISSING_SIGNATURE";
    constructor(message: string, code: "HASH_MISMATCH" | "BAD_SIGNATURE" | "MISSING_HASH" | "MISSING_SIGNATURE");
}
export declare function sha256File(path: string): Promise<string>;
/**
 * Verify a plugin tarball against its declared signature.
 *
 * Throws `PluginSignatureError` and (when supplied) emits an audit
 * failure event on rejection. On success, emits a `plugin.install`
 * success event.
 */
export declare function verifyPluginArtifact(input: VerifyPluginArtifactInput): Promise<void>;
//# sourceMappingURL=signature.d.ts.map