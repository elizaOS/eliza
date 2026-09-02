/**
 * Compatibility tests for the canonical local connector-token encryption
 * implementation. A fixed legacy envelope proves byte-level wire/key behavior
 * while real key-file tests preserve the existing deployment contract.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const raceChildPath = fileURLToPath(
	new URL("./fixtures/token-encryption-race-child.ts", import.meta.url),
);

async function waitForReadyFiles(dir: string, count: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (
			fs.readdirSync(dir).filter((entry) => entry.startsWith("ready-"))
				.length === count
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${count} key-creation participants`);
}

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

	it("returns the exclusive-create winner's key to every concurrent process", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-key-race-"));
		tempDirs.push(dir);
		const participantCount = 16;
		const children = Array.from({ length: participantCount }, (_, index) => {
			const child = spawn("bun", [raceChildPath, dir, String(index)], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			return new Promise<string>((resolve, reject) => {
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (chunk) => {
					stdout += chunk;
				});
				child.stderr.setEncoding("utf8").on("data", (chunk) => {
					stderr += chunk;
				});
				child.on("error", reject);
				child.on("exit", (code) => {
					if (code === 0) resolve(stdout);
					else reject(new Error(`race child exited ${code}: ${stderr}`));
				});
			});
		});

		await waitForReadyFiles(dir, participantCount);
		fs.writeFileSync(path.join(dir, "start"), "go");
		const keys = await Promise.all(children);

		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toHaveLength(64);
		expect(
			fs.readFileSync(path.join(dir, ".encryption-key"), "utf8").trim(),
		).toBe(Buffer.from(keys[0], "hex").toString("base64"));
		expect(fs.statSync(path.join(dir, ".encryption-key")).mode & 0o777).toBe(
			0o600,
		);
	}, 30_000);
});
