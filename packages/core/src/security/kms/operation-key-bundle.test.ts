/**
 * Proves the generic 64-byte operation-key-bundle provider with real Local KMS
 * cryptography and the real Steward HTTP adapter wire. Steward is represented
 * only by an injected encrypt/decrypt transport backed by Local KMS; no new
 * server endpoint or live credential is assumed.
 */

import { describe, expect, it } from "vitest";
import {
	AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
	AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
	canonicalizeAgentBackupOperationKeyBundleContext,
} from "../../../../shared/src/contracts/agent-backup-manifest-v3.js";
import { LocalKmsAdapter } from "./local-adapter.js";
import {
	computeKmsAeadOperationKeyBundleLocalReceiptDigest,
	KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
	KMS_AEAD_OPERATION_KEY_BUNDLE_V1,
	KmsAeadOperationKeyBundleProvider,
} from "./operation-key-bundle.js";
import { StewardKmsAdapter } from "./steward-adapter.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = `org:${ORGANIZATION_ID}/dek/v7`;

function context(kmsProvider: "local" | "steward" = "local"): Uint8Array {
	return new TextEncoder().encode(
		canonicalizeAgentBackupOperationKeyBundleContext({
			organizationId: ORGANIZATION_ID,
			agentId: "22222222-2222-4222-8222-222222222222",
			activationGeneration: "33333333-3333-4333-8333-333333333333",
			lifecycleRevision: "7",
			operationId: "44444444-4444-4444-8444-444444444444",
			keyBundleGenerationId: "55555555-5555-4555-8555-555555555555",
			sourceKind: "robot",
			sourceProvider: "hetzner",
			kmsProvider,
			keyId: KEY_ID,
			keyVersion: 7,
		}),
	);
}

function stewardWire(backing: LocalKmsAdapter, paths: string[]): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		paths.push(url.pathname);
		expect(request.headers.get("authorization")).toBe("Bearer test-token");
		const body = (await request.json()) as Record<string, unknown>;
		const keyId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
		const decode = (field: string) =>
			new Uint8Array(Buffer.from(String(body[field]), "base64"));
		const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

		if (url.pathname.endsWith("/encrypt")) {
			const encrypted = await backing.encrypt(
				keyId,
				decode("plaintext_b64"),
				decode("aad_b64"),
			);
			return Response.json({
				ciphertext_b64: encode(encrypted.ciphertext),
				nonce_b64: encode(encrypted.nonce),
				auth_tag_b64: encode(encrypted.authTag),
				version: encrypted.keyVersion,
			});
		}
		if (url.pathname.endsWith("/decrypt")) {
			const plaintext = await backing.decrypt(
				keyId,
				decode("ciphertext_b64"),
				decode("nonce_b64"),
				decode("auth_tag_b64"),
				decode("aad_b64"),
				Number(body.version),
			);
			return Response.json({ plaintext_b64: encode(plaintext) });
		}
		return Response.json({ error: "unexpected KMS endpoint" }, { status: 404 });
	}) as typeof fetch;
}

describe("KmsAeadOperationKeyBundleProvider", () => {
	it("acquires, immediately verifies, unwraps, and releases with real Local KMS", async () => {
		const provider = new KmsAeadOperationKeyBundleProvider(
			new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0x41) }),
		);
		const canonicalContext = context();
		const acquired = await provider.acquire({
			keyId: KEY_ID,
			keyVersion: 7,
			canonicalContext,
		});
		const originalDek = Uint8Array.from(acquired.handle.dek);
		const originalHmac = Uint8Array.from(acquired.handle.contentHmacKey);
		const acquiredDekView = acquired.handle.dek;
		const acquiredHmacView = acquired.handle.contentHmacKey;

		expect(KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION).toBe(
			AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
		);
		expect(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes).toBe(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes +
				KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes +
				KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes,
		);
		expect(KMS_AEAD_OPERATION_KEY_BUNDLE_V1).toMatchObject(
			AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
		);
		expect(acquired.wrapped).toMatchObject({
			format: "kms-aead-operation-key-bundle-v1",
			plaintextBytes: 64,
			nonceBytes: 12,
			authTagBytes: 16,
			bytes: 92,
			keyId: KEY_ID,
			keyVersion: 7,
			localReceiptDerivation:
				KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
		});
		expect(acquired.wrapped.localReceiptDigest).toBe(
			computeKmsAeadOperationKeyBundleLocalReceiptDigest({
				keyId: KEY_ID,
				keyVersion: 7,
				canonicalContext,
				wrappedKeyBundle: acquired.wrapped.wrappedKeyBundle,
			}),
		);
		expect(provider.release(acquired.handle)).toBe(true);
		expect(acquiredDekView.every((byte) => byte === 0)).toBe(true);
		expect(acquiredHmacView.every((byte) => byte === 0)).toBe(true);
		expect(() => acquired.handle.dek).toThrow("already been released");

		const unwrapped = await provider.unwrap({
			wrapped: acquired.wrapped,
			canonicalContext,
		});
		expect(unwrapped.dek).toEqual(originalDek);
		expect(unwrapped.contentHmacKey).toEqual(originalHmac);
		const unwrappedDekView = unwrapped.dek;
		const unwrappedHmacView = unwrapped.contentHmacKey;
		expect(provider.release(unwrapped)).toBe(true);
		expect(unwrappedDekView.every((byte) => byte === 0)).toBe(true);
		expect(unwrappedHmacView.every((byte) => byte === 0)).toBe(true);
		originalDek.fill(0);
		originalHmac.fill(0);
	});

	it("fails closed on changed context or receipt without returning plaintext", async () => {
		const provider = new KmsAeadOperationKeyBundleProvider(
			new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0x42) }),
		);
		const canonicalContext = context();
		const acquired = await provider.acquire({
			keyId: KEY_ID,
			keyVersion: 7,
			canonicalContext,
		});
		provider.release(acquired.handle);
		const wrongContext = Uint8Array.from(canonicalContext);
		wrongContext[wrongContext.byteLength - 1] ^= 1;
		await expect(
			provider.unwrap({
				wrapped: acquired.wrapped,
				canonicalContext: wrongContext,
			}),
		).rejects.toThrow();
		await expect(
			provider.unwrap({
				wrapped: { ...acquired.wrapped, localReceiptDigest: "0".repeat(64) },
				canonicalContext,
			}),
		).rejects.toMatchObject({
			code: "KMS_OPERATION_KEY_BUNDLE_ENVELOPE_INVALID",
		});
	});

	it("owns decrypted bytes and erases every KMS plaintext return", async () => {
		const localProvider = new KmsAeadOperationKeyBundleProvider(
			new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0x44) }),
		);
		const canonicalContext = context();
		const acquired = await localProvider.acquire({
			keyId: KEY_ID,
			keyVersion: 7,
			canonicalContext,
		});
		const expected = new Uint8Array(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
		);
		expected.set(
			acquired.handle.dek,
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.offsetBytes,
		);
		expected.set(
			acquired.handle.contentHmacKey,
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
		);
		localProvider.release(acquired.handle);

		const adapterPlaintext = Uint8Array.from(expected);
		const contextSnapshot = Uint8Array.from(canonicalContext);
		const envelopeSnapshot = Uint8Array.from(acquired.wrapped.wrappedKeyBundle);
		const aliasingProvider = new KmsAeadOperationKeyBundleProvider({
			encrypt: async () => {
				throw new Error("not used");
			},
			decrypt: async (_keyId, ciphertext, nonce, authTag, aad) => {
				ciphertext.fill(0);
				nonce.fill(0);
				authTag.fill(0);
				aad.fill(0);
				return adapterPlaintext;
			},
		});
		const unwrapped = await aliasingProvider.unwrap({
			wrapped: acquired.wrapped,
			canonicalContext,
		});
		expect(adapterPlaintext.every((byte) => byte === 0)).toBe(true);
		expect(canonicalContext).toEqual(contextSnapshot);
		expect(acquired.wrapped.wrappedKeyBundle).toEqual(envelopeSnapshot);
		expect(unwrapped.dek).toEqual(
			expected.subarray(0, KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.bytes),
		);
		expect(unwrapped.contentHmacKey).toEqual(
			expected.subarray(
				KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
			),
		);
		expect(aliasingProvider.release(unwrapped)).toBe(true);
		expect(aliasingProvider.release(unwrapped)).toBe(true);
		expected.fill(0);
		contextSnapshot.fill(0);
		envelopeSnapshot.fill(0);
	});

	it("erases KMS inputs and malformed plaintext on failed operations", async () => {
		expect(() =>
			computeKmsAeadOperationKeyBundleLocalReceiptDigest({
				keyId: KEY_ID,
				keyVersion: 7,
				canonicalContext: context(),
				wrappedKeyBundle: new Uint8Array(
					KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes - 1,
				),
			}),
		).toThrow("exactly 92 bytes");

		let encryptInput: Uint8Array | undefined;
		const failedContext = context();
		const failedContextSnapshot = Uint8Array.from(failedContext);
		const failedAcquireProvider = new KmsAeadOperationKeyBundleProvider({
			encrypt: async (_keyId, plaintext, aad) => {
				encryptInput = plaintext;
				aad.fill(0);
				throw new Error("synthetic wrap failure");
			},
			decrypt: async () => {
				throw new Error("not used");
			},
		});
		await expect(
			failedAcquireProvider.acquire({
				keyId: KEY_ID,
				keyVersion: 7,
				canonicalContext: failedContext,
			}),
		).rejects.toThrow("synthetic wrap failure");
		expect(encryptInput).toBeInstanceOf(Uint8Array);
		expect(encryptInput?.every((byte) => byte === 0)).toBe(true);
		expect(failedContext).toEqual(failedContextSnapshot);
		failedContextSnapshot.fill(0);

		const localProvider = new KmsAeadOperationKeyBundleProvider(
			new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0x45) }),
		);
		const canonicalContext = context();
		const acquired = await localProvider.acquire({
			keyId: KEY_ID,
			keyVersion: 7,
			canonicalContext,
		});
		localProvider.release(acquired.handle);
		const malformedPlaintext = new Uint8Array(63).fill(0x46);
		const malformedProvider = new KmsAeadOperationKeyBundleProvider({
			encrypt: async () => {
				throw new Error("not used");
			},
			decrypt: async () => malformedPlaintext,
		});
		await expect(
			malformedProvider.unwrap({
				wrapped: acquired.wrapped,
				canonicalContext,
			}),
		).rejects.toMatchObject({
			code: "KMS_OPERATION_KEY_BUNDLE_PROVIDER_INVALID",
		});
		expect(malformedPlaintext.every((byte) => byte === 0)).toBe(true);
	});

	it("uses only the existing Steward encrypt/decrypt wire and local receipts", async () => {
		const paths: string[] = [];
		const backing = new LocalKmsAdapter({
			rootKey: new Uint8Array(32).fill(0x43),
		});
		const steward = new StewardKmsAdapter({
			baseUrl: "https://steward.invalid",
			tokenProvider: async () => "test-token",
			fetch: stewardWire(backing, paths),
		});
		const provider = new KmsAeadOperationKeyBundleProvider(steward);
		const canonicalContext = context("steward");
		const acquired = await provider.acquire({
			keyId: KEY_ID,
			keyVersion: 7,
			canonicalContext,
		});
		provider.release(acquired.handle);
		const unwrapped = await provider.unwrap({
			wrapped: acquired.wrapped,
			canonicalContext,
		});
		expect(unwrapped.dek).toHaveLength(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.bytes,
		);
		expect(unwrapped.contentHmacKey).toHaveLength(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
		);
		provider.release(unwrapped);
		expect(paths).toEqual([
			`/v1/kms/keys/${encodeURIComponent(KEY_ID)}/encrypt`,
			`/v1/kms/keys/${encodeURIComponent(KEY_ID)}/decrypt`,
			`/v1/kms/keys/${encodeURIComponent(KEY_ID)}/decrypt`,
		]);
		expect(paths.every((path) => !path.includes("hmac"))).toBe(true);
	});
});
