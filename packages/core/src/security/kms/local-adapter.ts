/**
 * Local desktop KMS adapter that derives persistent symmetric keys from a caller-provided root key.
 */

import {
	createHmac,
	createPrivateKey,
	createPublicKey,
	sign as nodeSign,
	verify as nodeVerify,
	randomBytes,
	scryptSync,
	timingSafeEqual,
} from "node:crypto";
import { aeadDecrypt, aeadEncrypt } from "./crypto/aead.js";
import { hkdfSha256 } from "./crypto/hkdf.js";
import { parseKeyId, withVersion } from "./key-namespace.js";
import {
	type EncryptResult,
	type GetOrCreateKeyOptions,
	type KeyHandle,
	type KeyId,
	KeyNotFoundError,
	type KeyVersion,
	type KmsClient,
	KmsError,
	type SignatureAlgorithm,
	type SignResult,
} from "./types.js";

/**
 * Single-user desktop adapter.
 *
 * Wraps `@elizaos/vault`'s master-key resolution (OS keychain → scrypt passphrase)
 * to obtain a 32-byte root key, then derives per-`keyId` / per-version subkeys
 * via HKDF-SHA256. Signing keys are held in-process (regenerated on boot from
 * the same root via deterministic HKDF + ed25519 seed expansion).
 *
 * The version embedded in `keyId` is authoritative, so rotation returns a new
 * versioned key id that callers persist with ciphertext. No process-local
 * active-version state can roll back after restart.
 *
 * Symmetric and Ed25519 keys are deterministically derived so the same desktop
 * install can decrypt and verify its own data after restart. RSA is rejected
 * because a process-local fallback would produce unverifiable signatures after
 * restart.
 */
export interface LocalKmsOptions {
	/** 32-byte root key. Caller resolves via `@elizaos/vault` master-key API. */
	rootKey: Uint8Array;
}

const HKDF_DOMAIN = "elizaos.security.local-kms.v1";

export class LocalKmsAdapter implements KmsClient {
	private readonly rootKey: Uint8Array;

	constructor(opts: LocalKmsOptions) {
		if (opts.rootKey.length !== 32) {
			throw new KmsError("LocalKmsAdapter rootKey must be 32 bytes");
		}
		this.rootKey = opts.rootKey;
	}

	static fromPassphrase(passphrase: string, salt: string): LocalKmsAdapter {
		const rootKey = new Uint8Array(scryptSync(passphrase, salt, 32));
		return new LocalKmsAdapter({ rootKey });
	}

	private deriveSym(keyId: KeyId, version: KeyVersion): Uint8Array {
		const info = Buffer.from(`${HKDF_DOMAIN}|sym|${keyId}|v${version}`, "utf8");
		return hkdfSha256(this.rootKey, 32, info);
	}

	private deriveEd25519PrivateKey(keyId: KeyId, version: KeyVersion) {
		const info = Buffer.from(
			`${HKDF_DOMAIN}|sign|ed25519|${keyId}|v${version}`,
			"utf8",
		);
		const seed = Buffer.from(hkdfSha256(this.rootKey, 32, info));
		const pkcs8 = Buffer.concat([
			Buffer.from("302e020100300506032b657004220420", "hex"),
			seed,
		]);
		return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
	}

	private version(keyId: KeyId): KeyVersion {
		return parseKeyId(keyId).version;
	}

	async getOrCreateKey(
		keyId: KeyId,
		_opts: GetOrCreateKeyOptions = {},
	): Promise<KeyHandle> {
		return { keyId, version: this.version(keyId) };
	}

	async rotateKey(
		keyId: KeyId,
	): Promise<{ keyId: KeyId; newVersion: KeyVersion }> {
		const newVersion = this.version(keyId) + 1;
		const rotatedKeyId = withVersion(keyId, newVersion);
		return { keyId: rotatedKeyId, newVersion };
	}

	async listKeyVersions(keyId: KeyId): Promise<KeyVersion[]> {
		return [this.version(keyId)];
	}

	async encrypt(
		keyId: KeyId,
		plaintext: Uint8Array,
		aad?: Uint8Array,
	): Promise<EncryptResult> {
		const version = this.version(keyId);
		const k = this.deriveSym(keyId, version);
		const out = aeadEncrypt(k, plaintext, aad);
		return { ...out, keyId, keyVersion: version };
	}

	async decrypt(
		keyId: KeyId,
		ciphertext: Uint8Array,
		nonce: Uint8Array,
		authTag: Uint8Array,
		aad?: Uint8Array,
		keyVersion?: KeyVersion,
	): Promise<Uint8Array> {
		const currentVersion = this.version(keyId);
		const version = keyVersion ?? currentVersion;
		if (version !== currentVersion) {
			throw new KeyNotFoundError(keyId, version);
		}
		const k = this.deriveSym(keyId, version);
		return aeadDecrypt(k, ciphertext, nonce, authTag, aad);
	}

	async hmac(keyId: KeyId, data: Uint8Array): Promise<Uint8Array> {
		const version = this.version(keyId);
		const info = Buffer.from(
			`${HKDF_DOMAIN}|hmac|${keyId}|v${version}`,
			"utf8",
		);
		const macKey = hkdfSha256(this.rootKey, 32, info);
		const mac = createHmac("sha256", Buffer.from(macKey))
			.update(Buffer.from(data))
			.digest();
		return new Uint8Array(mac);
	}

	async hmacVerify(
		keyId: KeyId,
		data: Uint8Array,
		tag: Uint8Array,
	): Promise<boolean> {
		const version = this.version(keyId);
		const info = Buffer.from(
			`${HKDF_DOMAIN}|hmac|${keyId}|v${version}`,
			"utf8",
		);
		const macKey = hkdfSha256(this.rootKey, 32, info);
		const expected = createHmac("sha256", Buffer.from(macKey))
			.update(Buffer.from(data))
			.digest();
		return (
			expected.length === tag.length &&
			timingSafeEqual(expected, Buffer.from(tag))
		);
	}

	async sign(
		keyId: KeyId,
		data: Uint8Array,
		algo: SignatureAlgorithm = "ed25519",
	): Promise<SignResult> {
		if (algo === "ed25519") {
			const version = this.version(keyId);
			const privateKey = this.deriveEd25519PrivateKey(keyId, version);
			const signature = nodeSign(null, Buffer.from(data), privateKey);
			return {
				signature: new Uint8Array(signature),
				algorithm: algo,
				keyId,
				keyVersion: version,
			};
		}
		throw new KmsError(
			`LocalKmsAdapter does not support persistent ${algo} signing; use ed25519 or Steward KMS`,
		);
	}
	async verify(
		keyId: KeyId,
		data: Uint8Array,
		signature: Uint8Array,
		algo: SignatureAlgorithm = "ed25519",
	): Promise<boolean> {
		if (algo === "ed25519") {
			const version = this.version(keyId);
			const privateKey = this.deriveEd25519PrivateKey(keyId, version);
			const publicKey = createPublicKey(privateKey);
			return nodeVerify(
				null,
				Buffer.from(data),
				publicKey,
				Buffer.from(signature),
			);
		}
		throw new KmsError(
			`LocalKmsAdapter does not support persistent ${algo} verification; use ed25519 or Steward KMS`,
		);
	}
	async getPublicKey(keyId: KeyId): Promise<Uint8Array> {
		const version = this.version(keyId);
		const privateKey = this.deriveEd25519PrivateKey(keyId, version);
		const publicKey = createPublicKey(privateKey);
		return new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
	}
}

export function randomRootKey(): Uint8Array {
	return new Uint8Array(randomBytes(32));
}
