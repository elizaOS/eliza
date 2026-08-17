/**
 * Wraps one random 64-byte operation key bundle with an existing KMS client's
 * AEAD encrypt/decrypt methods. The first half is an AES-256 DEK and the second
 * half is an operation-scoped HMAC key. A fresh envelope is decrypted and
 * compared immediately before callers can persist or use it; deterministic
 * receipts are computed locally and require no additional KMS server API.
 */

import { createHash, randomFillSync, timingSafeEqual } from "node:crypto";
import { ElizaError } from "../../errors.js";
import { parseKeyId } from "./key-namespace.js";
import type { EncryptResult, KmsClient } from "./types.js";

export const KMS_AEAD_OPERATION_KEY_BUNDLE_V1 = Object.freeze({
	format: "kms-aead-operation-key-bundle-v1" as const,
	plaintextBytes: 64 as const,
	wrappedBytes: 92 as const,
	dek: Object.freeze({ offsetBytes: 0 as const, bytes: 32 as const }),
	contentHmac: Object.freeze({ offsetBytes: 32 as const, bytes: 32 as const }),
	nonceBytes: 12 as const,
	authTagBytes: 16 as const,
});

export const KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION =
	"elizaos.kms-aead-operation-key-bundle.local-receipt.v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_KEY_ID_BYTES = 512;

export interface KmsAeadOperationKeyBundleWrapped {
	format: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format;
	keyId: string;
	keyVersion: number;
	plaintextBytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes;
	nonceBytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes;
	authTagBytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes;
	bytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes;
	sha256: string;
	localReceiptDerivation: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION;
	localReceiptDigest: string;
	/** Exact nonce || ciphertext || authentication-tag envelope. */
	wrappedKeyBundle: Uint8Array;
}

export interface KmsAeadOperationKeyBundleHandle {
	readonly format: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format;
	readonly dek: Uint8Array;
	readonly contentHmacKey: Uint8Array;
	readonly released: boolean;
}

export interface AcquireKmsAeadOperationKeyBundleInput {
	keyId: string;
	keyVersion: number;
	canonicalContext: Uint8Array;
}

export interface UnwrapKmsAeadOperationKeyBundleInput {
	wrapped: Readonly<KmsAeadOperationKeyBundleWrapped>;
	canonicalContext: Uint8Array;
}

export class KmsAeadOperationKeyBundleError extends ElizaError {
	override readonly name = "KmsAeadOperationKeyBundleError";

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, { code, cause: options?.cause, severity: "fatal" });
	}
}

function bundleError(code: string, message: string, cause?: unknown): never {
	throw new KmsAeadOperationKeyBundleError(code, message, { cause });
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function assertCanonicalContext(context: Uint8Array): void {
	if (
		!(context instanceof Uint8Array) ||
		context.byteLength === 0 ||
		context.byteLength > MAX_CONTEXT_BYTES
	) {
		bundleError(
			"KMS_OPERATION_KEY_BUNDLE_CONTEXT_INVALID",
			"Operation key-bundle context must be non-empty and bounded",
		);
	}
}

function assertKmsAuthority(keyId: string, keyVersion: number): void {
	if (
		typeof keyId !== "string" ||
		keyId.length === 0 ||
		new TextEncoder().encode(keyId).byteLength > MAX_KEY_ID_BYTES
	) {
		bundleError(
			"KMS_OPERATION_KEY_BUNDLE_AUTHORITY_INVALID",
			"Operation key-bundle KMS key id is invalid",
		);
	}
	let parsed: ReturnType<typeof parseKeyId>;
	try {
		parsed = parseKeyId(keyId);
	} catch (cause) {
		// error-policy:J2 retain the namespace parser failure at this provider boundary.
		bundleError(
			"KMS_OPERATION_KEY_BUNDLE_AUTHORITY_INVALID",
			"Operation key-bundle KMS key id is not canonical",
			cause,
		);
	}
	if (
		!Number.isSafeInteger(keyVersion) ||
		keyVersion < 1 ||
		parsed.version !== keyVersion
	) {
		bundleError(
			"KMS_OPERATION_KEY_BUNDLE_AUTHORITY_INVALID",
			"Operation key-bundle KMS key version does not match its key id",
		);
	}
}

function canonicalReceipt(input: {
	keyId: string;
	keyVersion: number;
	canonicalContext: Uint8Array;
	wrappedKeyBundle: Uint8Array;
}): string {
	return JSON.stringify({
		derivation: KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
		format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
		keyId: input.keyId,
		keyVersion: input.keyVersion,
		contextSha256: sha256Hex(input.canonicalContext),
		wrappedKeyBundleSha256: sha256Hex(input.wrappedKeyBundle),
	});
}

/** Recompute the provider-independent receipt for an exact envelope/context. */
export function computeKmsAeadOperationKeyBundleLocalReceiptDigest(input: {
	keyId: string;
	keyVersion: number;
	canonicalContext: Uint8Array;
	wrappedKeyBundle: Uint8Array;
}): string {
	assertKmsAuthority(input.keyId, input.keyVersion);
	assertCanonicalContext(input.canonicalContext);
	if (
		!(input.wrappedKeyBundle instanceof Uint8Array) ||
		input.wrappedKeyBundle.byteLength !==
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes
	) {
		bundleError(
			"KMS_OPERATION_KEY_BUNDLE_ENVELOPE_INVALID",
			"Wrapped operation key bundle must contain exactly 92 bytes",
		);
	}
	return sha256Hex(new TextEncoder().encode(canonicalReceipt(input)));
}

function envelopeBytes(encrypted: EncryptResult): Uint8Array {
	if (
		!(encrypted.nonce instanceof Uint8Array) ||
		encrypted.nonce.byteLength !==
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes ||
		!(encrypted.ciphertext instanceof Uint8Array) ||
		encrypted.ciphertext.byteLength !==
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes ||
		!(encrypted.authTag instanceof Uint8Array) ||
		encrypted.authTag.byteLength !==
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes
	) {
		bundleError(
			"KMS_OPERATION_KEY_BUNDLE_PROVIDER_INVALID",
			"KMS encrypt returned an invalid AEAD operation key-bundle envelope",
		);
	}
	const envelope = new Uint8Array(
		encrypted.nonce.byteLength +
			encrypted.ciphertext.byteLength +
			encrypted.authTag.byteLength,
	);
	envelope.set(encrypted.nonce, 0);
	envelope.set(encrypted.ciphertext, encrypted.nonce.byteLength);
	envelope.set(
		encrypted.authTag,
		encrypted.nonce.byteLength + encrypted.ciphertext.byteLength,
	);
	return envelope;
}

function splitEnvelope(envelope: Uint8Array): {
	nonce: Uint8Array;
	ciphertext: Uint8Array;
	authTag: Uint8Array;
} {
	const expectedBytes =
		KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes +
		KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes +
		KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes;
	if (envelope.byteLength !== expectedBytes) {
		bundleError(
			"KMS_OPERATION_KEY_BUNDLE_ENVELOPE_INVALID",
			"Wrapped operation key-bundle envelope has an invalid byte length",
		);
	}
	const ciphertextEnd =
		envelope.byteLength - KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes;
	return {
		nonce: envelope.subarray(0, KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes),
		ciphertext: envelope.subarray(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes,
			ciphertextEnd,
		),
		authTag: envelope.subarray(ciphertextEnd),
	};
}

class OperationKeyBundleHandle implements KmsAeadOperationKeyBundleHandle {
	readonly format = KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format;
	private isReleased = false;

	constructor(private readonly plaintext: Uint8Array) {
		if (
			plaintext.byteLength !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes
		) {
			bundleError(
				"KMS_OPERATION_KEY_BUNDLE_PROVIDER_INVALID",
				"Plaintext operation key bundle must contain exactly 64 bytes",
			);
		}
	}

	get dek(): Uint8Array {
		this.assertActive();
		return this.plaintext.subarray(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.offsetBytes,
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.offsetBytes +
				KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.bytes,
		);
	}

	get contentHmacKey(): Uint8Array {
		this.assertActive();
		return this.plaintext.subarray(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes +
				KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
		);
	}

	get released(): boolean {
		return this.isReleased;
	}

	private assertActive(): void {
		if (this.isReleased) {
			bundleError(
				"KMS_OPERATION_KEY_BUNDLE_RELEASED",
				"Operation key bundle has already been released",
			);
		}
	}

	release(): void {
		if (this.isReleased) return;
		this.plaintext.fill(0);
		this.isReleased = true;
	}
}

/** Unified acquire/unwrap/release provider over any conforming KMS client. */
export class KmsAeadOperationKeyBundleProvider {
	private readonly ownedHandles = new WeakSet<OperationKeyBundleHandle>();

	constructor(private readonly kms: Pick<KmsClient, "encrypt" | "decrypt">) {}

	private own(plaintext: Uint8Array): OperationKeyBundleHandle {
		const handle = new OperationKeyBundleHandle(plaintext);
		this.ownedHandles.add(handle);
		return handle;
	}

	private async decryptAndVerify(input: {
		keyId: string;
		keyVersion: number;
		canonicalContext: Uint8Array;
		wrappedKeyBundle: Uint8Array;
	}): Promise<Uint8Array> {
		const parts = splitEnvelope(input.wrappedKeyBundle);
		const nonce = Uint8Array.from(parts.nonce);
		const ciphertext = Uint8Array.from(parts.ciphertext);
		const authTag = Uint8Array.from(parts.authTag);
		const decryptContext = Uint8Array.from(input.canonicalContext);
		try {
			const decrypted: unknown = await this.kms.decrypt(
				input.keyId,
				ciphertext,
				nonce,
				authTag,
				decryptContext,
				input.keyVersion,
			);
			if (
				!(decrypted instanceof Uint8Array) ||
				decrypted.byteLength !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes
			) {
				if (decrypted instanceof Uint8Array) decrypted.fill(0);
				bundleError(
					"KMS_OPERATION_KEY_BUNDLE_PROVIDER_INVALID",
					"KMS decrypt did not return one 64-byte operation key bundle",
				);
			}
			try {
				return Uint8Array.from(decrypted);
			} finally {
				// A KMS adapter must not retain plaintext through an aliased return view.
				decrypted.fill(0);
			}
		} finally {
			nonce.fill(0);
			ciphertext.fill(0);
			authTag.fill(0);
			decryptContext.fill(0);
		}
	}

	async acquire(
		input: Readonly<AcquireKmsAeadOperationKeyBundleInput>,
	): Promise<{
		handle: KmsAeadOperationKeyBundleHandle;
		wrapped: KmsAeadOperationKeyBundleWrapped;
	}> {
		assertKmsAuthority(input.keyId, input.keyVersion);
		assertCanonicalContext(input.canonicalContext);
		const canonicalContext = Uint8Array.from(input.canonicalContext);
		const plaintext = new Uint8Array(
			KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
		);
		try {
			randomFillSync(plaintext);
			const wrapCopy = Uint8Array.from(plaintext);
			const encryptContext = Uint8Array.from(canonicalContext);
			let wrappedKeyBundle: Uint8Array;
			try {
				const encrypted: EncryptResult = await this.kms.encrypt(
					input.keyId,
					wrapCopy,
					encryptContext,
				);
				if (
					encrypted.keyId !== input.keyId ||
					encrypted.keyVersion !== input.keyVersion
				) {
					bundleError(
						"KMS_OPERATION_KEY_BUNDLE_PROVIDER_INVALID",
						"KMS encrypt changed the requested key authority",
					);
				}
				wrappedKeyBundle = envelopeBytes(encrypted);
			} finally {
				wrapCopy.fill(0);
				encryptContext.fill(0);
			}
			const roundTrip = await this.decryptAndVerify({
				keyId: input.keyId,
				keyVersion: input.keyVersion,
				canonicalContext,
				wrappedKeyBundle,
			});
			let matches = false;
			try {
				matches = timingSafeEqual(roundTrip, plaintext);
			} finally {
				roundTrip.fill(0);
			}
			if (!matches) {
				wrappedKeyBundle.fill(0);
				bundleError(
					"KMS_OPERATION_KEY_BUNDLE_ENVELOPE_MISMATCH",
					"Fresh operation key bundle did not round-trip through its KMS envelope",
				);
			}
			const localReceiptDigest =
				computeKmsAeadOperationKeyBundleLocalReceiptDigest({
					keyId: input.keyId,
					keyVersion: input.keyVersion,
					canonicalContext,
					wrappedKeyBundle,
				});
			return {
				handle: this.own(plaintext),
				wrapped: {
					format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
					keyId: input.keyId,
					keyVersion: input.keyVersion,
					plaintextBytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
					nonceBytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes,
					authTagBytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes,
					bytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
					sha256: sha256Hex(wrappedKeyBundle),
					localReceiptDerivation:
						KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
					localReceiptDigest,
					wrappedKeyBundle,
				},
			};
		} catch (cause) {
			// error-policy:J2 generated key bytes are always erased before the
			// provider exposes a failed acquisition.
			plaintext.fill(0);
			throw cause;
		} finally {
			canonicalContext.fill(0);
		}
	}

	async unwrap(
		input: Readonly<UnwrapKmsAeadOperationKeyBundleInput>,
	): Promise<KmsAeadOperationKeyBundleHandle> {
		const { wrapped } = input;
		assertKmsAuthority(wrapped.keyId, wrapped.keyVersion);
		assertCanonicalContext(input.canonicalContext);
		const canonicalContext = Uint8Array.from(input.canonicalContext);
		try {
			if (
				wrapped.format !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format ||
				wrapped.plaintextBytes !==
					KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes ||
				wrapped.nonceBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes ||
				wrapped.authTagBytes !==
					KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes ||
				wrapped.bytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes ||
				wrapped.localReceiptDerivation !==
					KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION ||
				!(wrapped.wrappedKeyBundle instanceof Uint8Array)
			) {
				bundleError(
					"KMS_OPERATION_KEY_BUNDLE_ENVELOPE_INVALID",
					"Wrapped operation key-bundle metadata is invalid",
				);
			}
			const envelope = Uint8Array.from(wrapped.wrappedKeyBundle);
			try {
				if (
					wrapped.bytes !== envelope.byteLength ||
					!SHA256_PATTERN.test(wrapped.sha256) ||
					wrapped.sha256 !== sha256Hex(envelope) ||
					!SHA256_PATTERN.test(wrapped.localReceiptDigest) ||
					wrapped.localReceiptDigest !==
						computeKmsAeadOperationKeyBundleLocalReceiptDigest({
							keyId: wrapped.keyId,
							keyVersion: wrapped.keyVersion,
							canonicalContext,
							wrappedKeyBundle: envelope,
						})
				) {
					bundleError(
						"KMS_OPERATION_KEY_BUNDLE_ENVELOPE_INVALID",
						"Wrapped operation key bundle failed digest or receipt verification",
					);
				}
				const plaintext = await this.decryptAndVerify({
					keyId: wrapped.keyId,
					keyVersion: wrapped.keyVersion,
					canonicalContext,
					wrappedKeyBundle: envelope,
				});
				try {
					return this.own(plaintext);
				} catch (cause) {
					// error-policy:J2 a handle-construction failure cannot retain plaintext.
					plaintext.fill(0);
					throw cause;
				}
			} finally {
				envelope.fill(0);
			}
		} finally {
			canonicalContext.fill(0);
		}
	}

	release(handle: KmsAeadOperationKeyBundleHandle): true {
		if (
			!(handle instanceof OperationKeyBundleHandle) ||
			!this.ownedHandles.has(handle)
		) {
			bundleError(
				"KMS_OPERATION_KEY_BUNDLE_HANDLE_INVALID",
				"Operation key-bundle handle is not owned by this provider",
			);
		}
		handle.release();
		return true;
	}
}
