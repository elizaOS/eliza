/**
 * Real LocalKmsAdapter crypto plus the real StewardKmsAdapter HTTP wire prove
 * that backup DEKs can be wrapped before their envelope digest exists. The
 * digest is verified separately and is intentionally absent from wrap AAD.
 */

import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeAgentBackupDekContext } from "../../../../shared/src/contracts/agent-backup-manifest.js";
import { LocalKmsAdapter } from "./local-adapter.js";
import { StewardKmsAdapter } from "./steward-adapter.js";
import type { EncryptResult, KmsClient } from "./types.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const DEK_GENERATION_ID = "44444444-4444-4444-8444-444444444444";
const ACTIVATION_GENERATION = "55555555-5555-4555-8555-555555555555";
const KEY_ID = `org:${ORGANIZATION_ID}/dek/v7`;

function context(provider: "local" | "steward"): Uint8Array {
	return new TextEncoder().encode(
		canonicalizeAgentBackupDekContext({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			activationGeneration: ACTIVATION_GENERATION,
			lifecycleRevision: "7",
			operationId: OPERATION_ID,
			dekGenerationId: DEK_GENERATION_ID,
			sourceKind: "robot",
			sourceProvider: "hetzner",
			kmsProvider: provider,
			keyId: KEY_ID,
			keyVersion: 7,
		}),
	);
}

function envelopeBytes(encrypted: EncryptResult): Uint8Array {
	const bytes = new Uint8Array(
		encrypted.nonce.byteLength +
			encrypted.ciphertext.byteLength +
			encrypted.authTag.byteLength,
	);
	bytes.set(encrypted.nonce, 0);
	bytes.set(encrypted.ciphertext, encrypted.nonce.byteLength);
	bytes.set(
		encrypted.authTag,
		encrypted.nonce.byteLength + encrypted.ciphertext.byteLength,
	);
	return bytes;
}

async function proveRoundTrip(kms: KmsClient, provider: "local" | "steward") {
	const dataKey = new Uint8Array(randomBytes(32));
	const aad = context(provider);
	const wrapped = await kms.encrypt(KEY_ID, dataKey, aad);
	const envelope = envelopeBytes(wrapped);
	const wrappedDekSha256 = createHash("sha256").update(envelope).digest("hex");
	const canonicalContext = new TextDecoder().decode(aad);

	expect(canonicalContext).not.toContain(wrappedDekSha256);
	expect(canonicalContext).not.toContain("wrappedDekSha256");
	await expect(
		kms.decrypt(
			KEY_ID,
			wrapped.ciphertext,
			wrapped.nonce,
			wrapped.authTag,
			aad,
			wrapped.keyVersion,
		),
	).resolves.toEqual(dataKey);

	const wrongContext = Uint8Array.from(aad);
	wrongContext[wrongContext.byteLength - 1] ^= 1;
	await expect(
		kms.decrypt(
			KEY_ID,
			wrapped.ciphertext,
			wrapped.nonce,
			wrapped.authTag,
			wrongContext,
			wrapped.keyVersion,
		),
	).rejects.toThrow();
}

function stewardFetch(backing: LocalKmsAdapter): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = (await request.json()) as Record<string, unknown>;
		const keyId = decodeURIComponent(
			new URL(request.url).pathname.split("/").at(-2) ?? "",
		);
		const decode = (field: string) =>
			new Uint8Array(Buffer.from(String(body[field]), "base64"));
		const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

		if (request.url.endsWith("/encrypt")) {
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
		if (request.url.endsWith("/decrypt")) {
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
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

describe("agent backup DEK wrap context", () => {
	it("round-trips through real Local KMS without circular wrapped hash AAD", async () => {
		await proveRoundTrip(
			new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0x41) }),
			"local",
		);
	});

	it("round-trips through the real Steward adapter wire contract", async () => {
		const backing = new LocalKmsAdapter({
			rootKey: new Uint8Array(32).fill(0x42),
		});
		const steward = new StewardKmsAdapter({
			baseUrl: "https://steward.invalid",
			tokenProvider: async () => "test-token",
			fetch: stewardFetch(backing),
		});
		await proveRoundTrip(steward, "steward");
	});
});
