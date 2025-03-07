import * as path from "node:path";
import fs from "node:fs";
import * as crypto from "node:crypto";
import { x25519 } from "@noble/curves/ed25519";
import { hexToUint8Array, uint8ArrayToHex } from "./lib";
import os from "node:os";

const CONFIG_DIR = path.join(
	process.env.HOME || process.env.USERPROFILE || "~",
	".config",
	"tee-cli",
);
const CREDENTIAL_FILE = path.join(CONFIG_DIR, "credential.enc");
const KEY_FILE = path.join(CONFIG_DIR, ".key");

// Function to ensure the config directory exists
function ensureConfigDir() {
	if (!fs.existsSync(CONFIG_DIR)) {
		fs.mkdirSync(CONFIG_DIR, { recursive: true });
	}
}

// Get or create persistent key pair
function getKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
	ensureConfigDir();

	if (fs.existsSync(KEY_FILE)) {
		const keyData = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
		return {
			privateKey: hexToUint8Array(keyData.privateKey),
			publicKey: hexToUint8Array(keyData.publicKey),
		};
	}

	// Generate new key pair
	const privateKey = x25519.utils.randomPrivateKey();
	const publicKey = x25519.getPublicKey(privateKey);

	// Store the keys
	fs.writeFileSync(
		KEY_FILE,
		JSON.stringify({
			privateKey: uint8ArrayToHex(privateKey),
			publicKey: uint8ArrayToHex(publicKey),
		}),
		{ mode: 0o600 },
	); // Restrictive permissions

	return { privateKey, publicKey };
}

async function encryptApiKey(apiKey: string): Promise<string> {
	const { privateKey, publicKey } = getKeyPair();

	// Use the public key to encrypt (simulating a remote party)
	const shared = x25519.getSharedSecret(privateKey, publicKey);

	// Import shared key for AES-GCM
	const importedShared = await crypto.subtle.importKey(
		"raw",
		shared,
		{ name: "AES-GCM", length: 256 },
		true,
		["encrypt"],
	);

	// Encrypt the data
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		importedShared,
		new TextEncoder().encode(apiKey),
	);

	// Combine IV and encrypted data
	const result = new Uint8Array(iv.length + encrypted.byteLength);
	result.set(iv);
	result.set(new Uint8Array(encrypted), iv.length);

	return uint8ArrayToHex(result);
}

async function decryptApiKey(encryptedData: string): Promise<string> {
	const { privateKey, publicKey } = getKeyPair();

	// Recreate shared secret
	const shared = x25519.getSharedSecret(privateKey, publicKey);

	// Import shared key for AES-GCM
	const importedShared = await crypto.subtle.importKey(
		"raw",
		shared,
		{ name: "AES-GCM", length: 256 },
		true,
		["decrypt"],
	);

	// Split IV and encrypted data
	const data = hexToUint8Array(encryptedData);
	const iv = data.slice(0, 12);
	const encrypted = data.slice(12);

	// Decrypt the data
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		importedShared,
		encrypted,
	);

	return new TextDecoder().decode(decrypted);
}

export async function writeApiKey(apiKey: string) {
	ensureConfigDir();
	const encryptedApiKey = await encryptApiKey(apiKey);
	fs.writeFileSync(CREDENTIAL_FILE, encryptedApiKey);
	console.log(`API key securely saved to ${CREDENTIAL_FILE}`);
}

export async function getApiKey(): Promise<string | null> {
	try {
		if (!fs.existsSync(CREDENTIAL_FILE)) {
			return null;
		}
		const encryptedApiKey = fs.readFileSync(CREDENTIAL_FILE, "utf8");
		return await decryptApiKey(encryptedApiKey);
	} catch (error) {
		console.error("Error reading API key:", (error as Error).message);
		return null;
	}
}
