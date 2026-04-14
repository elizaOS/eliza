/**
 * Encryption module for secrets management
 *
 * Provides AES-256-GCM encryption with secure key derivation for protecting sensitive data.
 * Compatible with the Otto encryption approach while providing additional security features.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	pbkdf2Sync,
	randomBytes,
	scryptSync,
} from "node:crypto";
import type { EncryptedSecret, KeyDerivationParams } from "../types.ts";
import { EncryptionError } from "../types.ts";

// ============================================================================
// Constants
// ============================================================================

const ALGORITHM_GCM = "aes-256-gcm";
const ALGORITHM_CBC = "aes-256-cbc";
const IV_LENGTH = 16;
const _AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const DEFAULT_SALT_LENGTH = 32;
const DEFAULT_PBKDF2_ITERATIONS = 100000;

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Generate a cryptographically secure random salt
 */
export function generateSalt(length: number = DEFAULT_SALT_LENGTH): string {
	return randomBytes(length).toString("base64");
}

/**
 * Generate a random encryption key
 */
export function generateKey(): Buffer {
	return randomBytes(KEY_LENGTH);
}

/**
 * Derive an encryption key from a password/passphrase using PBKDF2
 *
 * @param password - The password or passphrase to derive from
 * @param salt - The salt (should be unique per key)
 * @param iterations - Number of PBKDF2 iterations (default: 100000)
 * @returns The derived key as a Buffer
 */
export function deriveKeyPbkdf2(
	password: string,
	salt: string | Buffer,
	iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Buffer {
	const saltBuffer =
		typeof salt === "string" ? Buffer.from(salt, "base64") : salt;
	return pbkdf2Sync(password, saltBuffer, iterations, KEY_LENGTH, "sha256");
}

/**
 * Derive an encryption key from a password using scrypt (more memory-hard)
 *
 * @param password - The password or passphrase to derive from
 * @param salt - The salt (should be unique per key)
 * @returns The derived key as a Buffer
 */
export function deriveKeyScrypt(
	password: string,
	salt: string | Buffer,
): Buffer {
	const saltBuffer =
		typeof salt === "string" ? Buffer.from(salt, "base64") : salt;
	return scryptSync(password, saltBuffer, KEY_LENGTH, {
		N: 16384,
		r: 8,
		p: 1,
	});
}

/**
 * Derive a key from agent ID and salt (Otto compatible)
 *
 * This method provides backward compatibility with Otto's key derivation approach.
 * For new implementations, prefer deriveKeyPbkdf2 or deriveKeyScrypt.
 *
 * @param agentId - The agent's unique identifier
 * @param salt - Optional salt (defaults to 'default-salt')
 * @returns The derived key as a Buffer
 */
export function deriveKeyFromAgentId(
	agentId: string,
	salt: string = "default-salt",
): Buffer {
	return createHash("sha256")
		.update(agentId + salt)
		.digest();
}

/**
 * Create key derivation parameters for storage
 */
export function createKeyDerivationParams(
	salt?: string,
	iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): KeyDerivationParams {
	return {
		salt: salt ?? generateSalt(),
		iterations,
		algorithm: "pbkdf2-sha256",
		keyLength: KEY_LENGTH,
	};
}

// ============================================================================
// Encryption
// ============================================================================

/**
 * Encrypt a value using AES-256-GCM
 *
 * GCM mode provides both confidentiality and authenticity, making it the preferred
 * choice for encrypting secrets. The authentication tag prevents tampering.
 *
 * @param plaintext - The value to encrypt
 * @param key - The encryption key (32 bytes)
 * @param keyId - Identifier for the key (for rotation support)
 * @returns Encrypted secret container
 */
export function encryptGcm(
	plaintext: string,
	key: Buffer,
	keyId: string = "default",
): EncryptedSecret {
	if (key.length !== KEY_LENGTH) {
		throw new EncryptionError(
			`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`,
		);
	}

	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM_GCM, key, iv);

	let encrypted = cipher.update(plaintext, "utf8", "base64");
	encrypted += cipher.final("base64");

	const authTag = cipher.getAuthTag();

	return {
		value: encrypted,
		iv: iv.toString("base64"),
		authTag: authTag.toString("base64"),
		algorithm: "aes-256-gcm",
		keyId,
	};
}

/**
 * Encrypt a value using AES-256-CBC (fallback for compatibility)
 *
 * CBC mode is provided for backward compatibility. For new implementations,
 * prefer encryptGcm which provides authentication.
 *
 * @param plaintext - The value to encrypt
 * @param key - The encryption key (32 bytes)
 * @param keyId - Identifier for the key (for rotation support)
 * @returns Encrypted secret container
 */
export function encryptCbc(
	plaintext: string,
	key: Buffer,
	keyId: string = "default",
): EncryptedSecret {
	void plaintext;
	void key;
	void keyId;
	throw new EncryptionError(
		"AES-256-CBC encryption is disabled. Use AES-256-GCM and migrate any legacy callers.",
	);
}

/**
 * Encrypt a value using the default algorithm (GCM)
 */
export function encrypt(
	plaintext: string,
	key: Buffer,
	keyId: string = "default",
): EncryptedSecret {
	return encryptGcm(plaintext, key, keyId);
}

// ============================================================================
// Decryption
// ============================================================================

/**
 * Decrypt a value encrypted with AES-256-GCM
 *
 * @param encrypted - The encrypted secret container
 * @param key - The decryption key (32 bytes)
 * @returns The decrypted plaintext
 */
export function decryptGcm(encrypted: EncryptedSecret, key: Buffer): string {
	if (key.length !== KEY_LENGTH) {
		throw new EncryptionError(
			`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`,
		);
	}

	if (encrypted.algorithm !== "aes-256-gcm") {
		throw new EncryptionError(
			`Algorithm mismatch: expected aes-256-gcm, got ${encrypted.algorithm}`,
		);
	}

	if (!encrypted.authTag) {
		throw new EncryptionError("Missing authentication tag for GCM decryption");
	}

	const iv = Buffer.from(encrypted.iv, "base64");
	const authTag = Buffer.from(encrypted.authTag, "base64");
	const decipher = createDecipheriv(ALGORITHM_GCM, key, iv);
	decipher.setAuthTag(authTag);

	let decrypted = decipher.update(encrypted.value, "base64", "utf8");
	decrypted += decipher.final("utf8");

	return decrypted;
}

/**
 * Decrypt a value encrypted with AES-256-CBC
 *
 * @param encrypted - The encrypted secret container
 * @param key - The decryption key (32 bytes)
 * @returns The decrypted plaintext
 */
export function decryptCbc(encrypted: EncryptedSecret, key: Buffer): string {
	if (key.length !== KEY_LENGTH) {
		throw new EncryptionError(
			`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`,
		);
	}

	if (encrypted.algorithm !== "aes-256-cbc") {
		throw new EncryptionError(
			`Algorithm mismatch: expected aes-256-cbc, got ${encrypted.algorithm}`,
		);
	}

	const iv = Buffer.from(encrypted.iv, "base64");
	const decipher = createDecipheriv(ALGORITHM_CBC, key, iv);

	let decrypted = decipher.update(encrypted.value, "base64", "utf8");
	decrypted += decipher.final("utf8");

	return decrypted;
}

/**
 * Decrypt a value using the appropriate algorithm
 *
 * @param encrypted - The encrypted secret container (or raw string for backward compat)
 * @param key - The decryption key (32 bytes)
 * @returns The decrypted plaintext
 */
export function decrypt(
	encrypted: EncryptedSecret | string,
	key: Buffer,
): string {
	// Handle backward compatibility with unencrypted strings
	if (typeof encrypted === "string") {
		return encrypted;
	}

	switch (encrypted.algorithm) {
		case "aes-256-gcm":
			return decryptGcm(encrypted, key);
		case "aes-256-cbc":
			return decryptCbc(encrypted, key);
		default:
			throw new EncryptionError(
				`Unsupported algorithm: ${encrypted.algorithm}`,
			);
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a value appears to be an encrypted secret
 */
export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
	if (!value || typeof value !== "object") {
		return false;
	}

	const obj = value as Record<string, unknown>;
	return (
		typeof obj.value === "string" &&
		typeof obj.iv === "string" &&
		typeof obj.algorithm === "string" &&
		(obj.algorithm === "aes-256-gcm" || obj.algorithm === "aes-256-cbc")
	);
}

/**
 * Generate a secure random string for tokens, IDs, etc.
 */
export function generateSecureToken(length: number = 32): string {
	return randomBytes(length).toString("hex");
}

/**
 * Hash a value for comparison or fingerprinting (not for passwords)
 */
export function hashValue(
	value: string,
	algorithm: "sha256" | "sha512" = "sha256",
): string {
	return createHash(algorithm).update(value).digest("hex");
}

/**
 * Securely compare two strings in constant time to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);

	let result = 0;
	for (let i = 0; i < bufA.length; i++) {
		result |= bufA[i] ^ bufB[i];
	}

	return result === 0;
}

// ============================================================================
// Key Manager Class
// ============================================================================

/**
 * Manages encryption keys with support for rotation and multiple key IDs
 */
export class KeyManager {
	private keys: Map<string, Buffer> = new Map();
	private currentKeyId: string = "default";
	private derivationParams: KeyDerivationParams | null = null;

	constructor(options?: {
		primaryKey?: Buffer;
		primaryKeyId?: string;
		derivationParams?: KeyDerivationParams;
	}) {
		if (options?.primaryKey) {
			const keyId = options.primaryKeyId ?? "default";
			this.keys.set(keyId, options.primaryKey);
			this.currentKeyId = keyId;
		}
		if (options?.derivationParams) {
			this.derivationParams = options.derivationParams;
		}
	}

	/**
	 * Initialize with a password-derived key
	 */
	initializeFromPassword(password: string, salt?: string): void {
		this.derivationParams = createKeyDerivationParams(salt);
		const key = deriveKeyPbkdf2(
			password,
			this.derivationParams.salt,
			this.derivationParams.iterations,
		);
		this.keys.set("default", key);
		this.currentKeyId = "default";
	}

	/**
	 * Initialize with an agent ID (Otto compatible)
	 */
	initializeFromAgentId(agentId: string, salt?: string): void {
		const key = deriveKeyFromAgentId(agentId, salt);
		this.keys.set("default", key);
		this.currentKeyId = "default";
	}

	/**
	 * Add a key for decryption (supports key rotation)
	 */
	addKey(keyId: string, key: Buffer): void {
		this.keys.set(keyId, key);
	}

	/**
	 * Set the current key for encryption
	 */
	setCurrentKey(keyId: string): void {
		if (!this.keys.has(keyId)) {
			throw new EncryptionError(`Key not found: ${keyId}`);
		}
		this.currentKeyId = keyId;
	}

	/**
	 * Get the current key ID
	 */
	getCurrentKeyId(): string {
		return this.currentKeyId;
	}

	/**
	 * Get a key by ID
	 */
	getKey(keyId: string): Buffer | undefined {
		return this.keys.get(keyId);
	}

	/**
	 * Get the current encryption key
	 */
	getCurrentKey(): Buffer {
		const key = this.keys.get(this.currentKeyId);
		if (!key) {
			throw new EncryptionError("No encryption key configured");
		}
		return key;
	}

	/**
	 * Get derivation parameters (for storage)
	 */
	getDerivationParams(): KeyDerivationParams | null {
		return this.derivationParams;
	}

	/**
	 * Encrypt a value with the current key
	 */
	encrypt(plaintext: string): EncryptedSecret {
		return encryptGcm(plaintext, this.getCurrentKey(), this.currentKeyId);
	}

	/**
	 * Decrypt a value (automatically selects the correct key)
	 */
	decrypt(encrypted: EncryptedSecret | string): string {
		if (typeof encrypted === "string") {
			return encrypted;
		}

		const key = this.keys.get(encrypted.keyId);
		if (!key) {
			throw new EncryptionError(
				`Key not found for decryption: ${encrypted.keyId}`,
			);
		}

		return decrypt(encrypted, key);
	}

	/**
	 * Re-encrypt a value with the current key (for key rotation)
	 */
	reencrypt(encrypted: EncryptedSecret): EncryptedSecret {
		const plaintext = this.decrypt(encrypted);
		return this.encrypt(plaintext);
	}

	/**
	 * Clear all keys from memory
	 */
	clear(): void {
		// Overwrite key buffers before clearing
		for (const key of this.keys.values()) {
			key.fill(0);
		}
		this.keys.clear();
	}
}

// ============================================================================
// Exports
// ============================================================================

export {
	ALGORITHM_CBC,
	ALGORITHM_GCM,
	DEFAULT_PBKDF2_ITERATIONS,
	DEFAULT_SALT_LENGTH,
	IV_LENGTH,
	KEY_LENGTH,
};
