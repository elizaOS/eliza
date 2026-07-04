/**
 * Deterministic unit test for BrokerSecretStorage (features/secrets/storage):
 * the non-decrypting invariant (get() returns serialized handles, refuses to
 * pass through smuggled plaintext, and the source imports no decrypt path),
 * read-only vs write-capable set(), and fail-closed-vs-soft error handling under
 * strict/non-strict config. Uses vi-mocked broker clients and reads its own
 * backend source for the structural guard.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
	ISecretBrokerClient,
	SecretContext,
	SecretHandle,
} from "../types.ts";
import {
	isSerializedSecretHandle,
	parseSecretHandle,
	SECRET_HANDLE_MARKER,
} from "../types.ts";
import type { SecretsBrokerConfig } from "./broker-config.ts";
import { SecretsBrokerUnavailableError } from "./broker-config.ts";
import { BrokerSecretStorage } from "./broker-store.ts";

const CONTEXT: SecretContext = {
	level: "global",
	agentId: "00000000-0000-0000-0000-000000000000",
};

function config(over: Partial<SecretsBrokerConfig> = {}): SecretsBrokerConfig {
	return {
		url: "https://broker.example",
		token: "handle-abc",
		strict: false,
		...over,
	};
}

function handle(over: Partial<SecretHandle> = {}): SecretHandle {
	return {
		marker: SECRET_HANDLE_MARKER,
		ref: "lease-123",
		key: "OPENAI_API_KEY",
		resolveVia: "model-gateway",
		...over,
	};
}

describe("BrokerSecretStorage — non-decrypting invariant", () => {
	it("SOURCE never imports or references the local decrypt path", () => {
		// Structural guard: the whole point of the broker backend is that it has
		// NO code path to plaintext. Assert the source imports neither the
		// KeyManager nor the encryption module, and never calls `.decrypt`.
		const raw = readFileSync(
			fileURLToPath(new URL("./broker-store.ts", import.meta.url)),
			"utf8",
		);
		// Strip comments so the assertion targets CODE, not the docstring that
		// (deliberately) names KeyManager/decrypt while explaining their absence.
		const code = raw
			.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
			.replace(/(^|\s)\/\/[^\n]*/g, "$1"); // line comments
		// No import of the encryption module (the only source of plaintext).
		expect(code).not.toMatch(/from\s+["'].*crypto\/encryption/);
		// No reference to the KeyManager (the decrypt-capable object).
		expect(code).not.toMatch(/KeyManager/);
		// No decrypt call anywhere in the code.
		expect(code).not.toMatch(/\.decrypt\(/);
	});

	it("get() returns a serialized handle, never the plaintext", async () => {
		// A hostile/buggy broker that tries to smuggle a raw value in must not be
		// able to: the store re-serializes only the reference fields.
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => true),
			issueHandle: vi.fn(async () =>
				handle({
					// deliberately inject a stray plaintext-looking field
					...({ value: "sk-super-secret-plaintext" } as object),
				}),
			),
		};
		const store = new BrokerSecretStorage(broker, config());

		const result = await store.get("OPENAI_API_KEY", CONTEXT);

		expect(result).not.toBeNull();
		expect(isSerializedSecretHandle(result)).toBe(true);
		expect(result).not.toContain("sk-super-secret-plaintext");

		const parsed = parseSecretHandle(result);
		expect(parsed?.marker).toBe(SECRET_HANDLE_MARKER);
		expect(parsed?.ref).toBe("lease-123");
		expect(parsed?.key).toBe("OPENAI_API_KEY");
		// the smuggled field did not survive re-serialization
		expect((parsed as unknown as { value?: string })?.value).toBeUndefined();
	});

	it("get() returns null when the broker has no such secret", async () => {
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => false),
			issueHandle: vi.fn(async () => null),
		};
		const store = new BrokerSecretStorage(broker, config());
		expect(await store.get("MISSING", CONTEXT)).toBeNull();
	});

	it("set() REFUSES on a read-only broker (no local fallback)", async () => {
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => false),
			issueHandle: vi.fn(async () => null),
			// no storeSecret -> read-only
		};
		const store = new BrokerSecretStorage(broker, config());
		expect(await store.set("K", "v", CONTEXT)).toBe(false);
	});

	it("set() delegates to a write-capable broker", async () => {
		const storeSecret = vi.fn(async () => true);
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => false),
			issueHandle: vi.fn(async () => null),
			storeSecret,
		};
		const store = new BrokerSecretStorage(broker, config());
		expect(await store.set("K", "v", CONTEXT)).toBe(true);
		expect(storeSecret).toHaveBeenCalledWith("K", "v", CONTEXT);
	});

	it("getConfig()/updateConfig() never fabricate a plaintext-bearing config", async () => {
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => true),
			issueHandle: vi.fn(async () => handle()),
		};
		const store = new BrokerSecretStorage(broker, config());
		expect(await store.getConfig("K", CONTEXT)).toBeNull();
		expect(await store.updateConfig("K", CONTEXT, {})).toBe(false);
	});
});

describe("BrokerSecretStorage — fail-closed vs fail-soft", () => {
	it("strict: broker error on get() throws SecretsBrokerUnavailableError", async () => {
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
			issueHandle: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		};
		const store = new BrokerSecretStorage(broker, config({ strict: true }));
		await expect(store.get("K", CONTEXT)).rejects.toBeInstanceOf(
			SecretsBrokerUnavailableError,
		);
	});

	it("strict: broker error on exists() throws (no silent false)", async () => {
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
			issueHandle: vi.fn(async () => null),
		};
		const store = new BrokerSecretStorage(broker, config({ strict: true }));
		await expect(store.exists("K", CONTEXT)).rejects.toBeInstanceOf(
			SecretsBrokerUnavailableError,
		);
	});

	it("non-strict: broker error on get() returns null (soft)", async () => {
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => false),
			issueHandle: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		};
		const store = new BrokerSecretStorage(broker, config({ strict: false }));
		expect(await store.get("K", CONTEXT)).toBeNull();
	});

	it("non-strict: broker error on exists() returns false (soft)", async () => {
		const broker: ISecretBrokerClient = {
			hasSecret: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
			issueHandle: vi.fn(async () => null),
		};
		const store = new BrokerSecretStorage(broker, config({ strict: false }));
		expect(await store.exists("K", CONTEXT)).toBe(false);
	});
});
