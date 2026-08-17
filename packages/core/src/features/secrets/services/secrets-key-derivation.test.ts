/**
 * SecretsService key derivation (W1-061): the active encryption key must be
 * derived from the high-entropy ENCRYPTION_SALT — not from the public agentId
 * (logs, API responses, DB rows), which contributed zero entropy as the KDF
 * password. The legacy agentId-keyed key stays registered under keyId
 * "default" so ciphertext written by older builds still decrypts. Pure unit
 * test against createMockRuntime — no storage I/O.
 */

import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import { deriveKeyPbkdf2, KeyManager } from "../crypto/encryption.ts";
import { SecretsService } from "./secrets.ts";

const ENCRYPTION_SALT = "unit-test-salt";
const AGENT_ID =
	"11111111-2222-3333-4444-555555555555" as IAgentRuntime["agentId"];

function runtime(): IAgentRuntime {
	return createMockRuntime({
		agentId: AGENT_ID,
		getSetting: ((key: string) =>
			key === "ENCRYPTION_SALT"
				? ENCRYPTION_SALT
				: undefined) as IAgentRuntime["getSetting"],
		character: {
			name: "T",
			bio: [],
			settings: { secrets: {} },
		} as IAgentRuntime["character"],
	});
}

describe("SecretsService key derivation (W1-061)", () => {
	it("derives the active key from the salt, not the public agentId", async () => {
		const service = await SecretsService.start(runtime());
		const keyManager = service.getKeyManager();

		// New writes go out under the strong "v2" key…
		expect(keyManager.getCurrentKeyId()).toBe("v2");

		// …which differs from the legacy agentId-password derivation.
		const legacyKey = deriveKeyPbkdf2(AGENT_ID, ENCRYPTION_SALT);
		expect(keyManager.getKey("v2")).not.toEqual(legacyKey);

		// The strong key is PBKDF2 over the salt, domain-bound to the agent.
		const expected = deriveKeyPbkdf2(
			ENCRYPTION_SALT,
			Buffer.from(`elizaos:secrets:v2:${AGENT_ID}`, "utf8"),
		);
		expect(keyManager.getKey("v2")).toEqual(expected);

		await service.stop();
	});

	it("round-trips new ciphertext under the v2 key", async () => {
		const service = await SecretsService.start(runtime());
		const keyManager = service.getKeyManager();

		const encrypted = keyManager.encrypt("sk-live-secret-value");
		expect(encrypted.keyId).toBe("v2");
		expect(keyManager.decrypt(encrypted)).toBe("sk-live-secret-value");

		await service.stop();
	});

	it("still decrypts legacy ciphertext keyed by the agentId derivation", async () => {
		// Ciphertext produced by a pre-fix build: keyId "default", PBKDF2 with
		// the agentId as the KDF password.
		const legacyManager = new KeyManager();
		legacyManager.initializeFromPassword(AGENT_ID, ENCRYPTION_SALT);
		const legacyCiphertext = legacyManager.encrypt("legacy-secret");
		expect(legacyCiphertext.keyId).toBe("default");

		const service = await SecretsService.start(runtime());
		expect(service.getKeyManager().decrypt(legacyCiphertext)).toBe(
			"legacy-secret",
		);

		await service.stop();
	});
});
