/**
 * Node-only AES-256-GCM envelope and key-file implementation for local
 * connector credentials. The wire discriminator, version, key environment
 * variable, and `.encryption-key` filename preserve existing health and finance
 * ciphertext without re-encryption.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_ENV_VAR = "ELIZA_TOKEN_ENCRYPTION_KEY";
const KEY_FILENAME = ".encryption-key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;
const ENVELOPE_DISCRIMINATOR = "__enc" as const;

export interface EncryptedTokenEnvelope {
	readonly [ENVELOPE_DISCRIMINATOR]: "aes-256-gcm";
	readonly v: typeof ENVELOPE_VERSION;
	readonly iv: string;
	readonly tag: string;
	readonly ct: string;
}

function decodeKeyMaterial(raw: string): Buffer {
	const trimmed = raw.trim();
	if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
		return Buffer.from(trimmed, "hex");
	}
	const decoded = Buffer.from(trimmed, "base64");
	if (decoded.length === KEY_BYTES) return decoded;
	throw new Error(
		`${KEY_ENV_VAR} must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length})`,
	);
}

function loadOrCreateKeyFile(credentialsDir: string): Buffer {
	const filePath = path.join(credentialsDir, KEY_FILENAME);
	if (fs.existsSync(filePath)) {
		return decodeKeyMaterial(fs.readFileSync(filePath, "utf8"));
	}
	fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
	const key = crypto.randomBytes(KEY_BYTES);
	fs.writeFileSync(filePath, key.toString("base64"), {
		encoding: "utf8",
		mode: 0o600,
	});
	return key;
}

export function resolveTokenEncryptionKey(
	credentialsDir: string,
	env: NodeJS.ProcessEnv = process.env,
): Buffer {
	const fromEnv = env[KEY_ENV_VAR]?.trim();
	return fromEnv
		? decodeKeyMaterial(fromEnv)
		: loadOrCreateKeyFile(credentialsDir);
}

export function encryptTokenPayload(
	plaintextJson: string,
	key: Buffer,
): EncryptedTokenEnvelope {
	if (key.length !== KEY_BYTES) {
		throw new Error(
			`Token encryption key must be ${KEY_BYTES} bytes (got ${key.length})`,
		);
	}
	const iv = crypto.randomBytes(IV_BYTES);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintextJson, "utf8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();
	if (authTag.length !== AUTH_TAG_BYTES) {
		throw new Error("AES-GCM auth tag had unexpected length");
	}
	return {
		[ENVELOPE_DISCRIMINATOR]: "aes-256-gcm",
		v: ENVELOPE_VERSION,
		iv: iv.toString("base64"),
		tag: authTag.toString("base64"),
		ct: ciphertext.toString("base64"),
	};
}

export function decryptTokenEnvelope(
	envelope: EncryptedTokenEnvelope,
	key: Buffer,
): string {
	if (envelope[ENVELOPE_DISCRIMINATOR] !== "aes-256-gcm") {
		throw new Error("Unsupported token envelope algorithm");
	}
	if (envelope.v !== ENVELOPE_VERSION) {
		throw new Error(`Unsupported token envelope version: ${envelope.v}`);
	}
	const decipher = crypto.createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(envelope.iv, "base64"),
		{ authTagLength: AUTH_TAG_BYTES },
	);
	decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(envelope.ct, "base64")),
		decipher.final(),
	]).toString("utf8");
}

export function isEncryptedTokenEnvelope(
	value: unknown,
): value is EncryptedTokenEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>)[ENVELOPE_DISCRIMINATOR] === "aes-256-gcm"
	);
}
