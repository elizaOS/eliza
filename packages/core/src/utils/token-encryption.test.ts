/**
 * Compatibility tests for the canonical local connector-token encryption
 * implementation. A fixed legacy envelope proves byte-level wire/key behavior
 * while real key-file tests preserve the existing deployment contract.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decryptTokenEnvelope,
	encryptTokenPayload,
	resolveTokenEncryptionKey,
} from "./token-encryption.js";

const KEY = Buffer.alloc(32, 7);
const LEGACY_ENVELOPE = {
	__enc: "aes-256-gcm" as const,
	v: 1 as const,
	iv: "AAECAwQFBgcICQoL",
	tag: "M8rZ1OYoJsWd/+uvKkWHzg==",
	ct: "dOSOEX5w9D9G",
};
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("connector token encryption compatibility", () => {
	it("decrypts the exact v1 AES-256-GCM envelope emitted by legacy plugins", () => {
		expect(decryptTokenEnvelope(LEGACY_ENVELOPE, KEY)).toBe("legacy-v1");
	});

	it("emits the unchanged discriminator/version and round-trips plaintext", () => {
		const envelope = encryptTokenPayload("current", KEY);
		expect({ algorithm: envelope.__enc, version: envelope.v }).toEqual({
			algorithm: "aes-256-gcm",
			version: 1,
		});
		expect(decryptTokenEnvelope(envelope, KEY)).toBe("current");
	});

	it("preserves env decoding and the .encryption-key path and mode", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-encryption-"));
		tempDirs.push(dir);
		expect(
			resolveTokenEncryptionKey("/unused", {
				ELIZA_TOKEN_ENCRYPTION_KEY: KEY.toString("hex"),
			} as NodeJS.ProcessEnv).equals(KEY),
		).toBe(true);
		const generated = resolveTokenEncryptionKey(dir, {} as NodeJS.ProcessEnv);
		const file = path.join(dir, ".encryption-key");
		expect(generated).toHaveLength(32);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(
			resolveTokenEncryptionKey(dir, {} as NodeJS.ProcessEnv).equals(generated),
		).toBe(true);
	});
});
