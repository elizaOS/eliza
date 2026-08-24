/**
 * Deterministic unit tests for the secrets capability's shared runtime
 * surface (features/secrets/types): the broker SecretHandle
 * serialize/guard/parse contract consumed by `ISecretStorage.get`, the
 * secrets error taxonomy consumed by caller catch-dispatch, and the
 * secret-key pattern used to classify keys. No live model, network, or
 * storage backend.
 */
import { describe, expect, it } from "vitest";
import {
	EncryptionError,
	isSerializedSecretHandle,
	MAX_ACCESS_LOG_ENTRIES,
	PermissionDeniedError,
	parseSecretHandle,
	SECRET_HANDLE_MARKER,
	SECRET_KEY_PATTERN,
	type SecretHandle,
	SecretNotFoundError,
	SecretsError,
	StorageError,
	serializeSecretHandle,
	ValidationError,
} from "./types";

const handle: SecretHandle = {
	marker: SECRET_HANDLE_MARKER,
	ref: "broker://vault/db-password#lease-1",
	key: "DB_PASSWORD",
	resolveVia: "credential-proxy",
	brokerUrl: "https://broker.example.com",
	expiresAt: 1893456000000,
};

describe("secret handle serialization", () => {
	it("prefixes the marker sentinel before the JSON body", () => {
		const serialized = serializeSecretHandle(handle);

		expect(serialized.startsWith(`${SECRET_HANDLE_MARKER}:`)).toBe(true);
		expect(
			JSON.parse(serialized.slice(`${SECRET_HANDLE_MARKER}:`.length)),
		).toEqual(handle);
	});

	it("round-trips every declared field through parse", () => {
		const parsed = parseSecretHandle(serializeSecretHandle(handle));

		expect(parsed).toEqual(handle);
		expect(parsed?.marker).toBe(SECRET_HANDLE_MARKER);
		expect(parsed?.resolveVia).toBe("credential-proxy");
	});
});

describe("isSerializedSecretHandle guard", () => {
	it("accepts a serialized handle", () => {
		expect(isSerializedSecretHandle(serializeSecretHandle(handle))).toBe(true);
	});

	it("rejects null", () => {
		expect(isSerializedSecretHandle(null)).toBe(false);
	});

	it("rejects a plaintext-looking value without the prefix", () => {
		expect(isSerializedSecretHandle("sk-live-abc123")).toBe(false);
	});

	it("rejects the bare marker without its colon separator", () => {
		expect(isSerializedSecretHandle(SECRET_HANDLE_MARKER)).toBe(false);
	});

	it("accepts any prefixed string and leaves validation to parse", () => {
		expect(isSerializedSecretHandle(`${SECRET_HANDLE_MARKER}:{broken`)).toBe(
			true,
		);
	});
});

describe("parseSecretHandle fail-closed parsing", () => {
	it("returns null for null", () => {
		expect(parseSecretHandle(null)).toBeNull();
	});

	it("returns null for a string without the prefix", () => {
		expect(parseSecretHandle("eliza:secret-handle:v1-no-colon")).toBeNull();
		expect(parseSecretHandle("{}")).toBeNull();
	});

	it("returns null for malformed JSON after the prefix", () => {
		expect(parseSecretHandle(`${SECRET_HANDLE_MARKER}:{not json`)).toBeNull();
	});

	it("returns null when the embedded marker does not match", () => {
		const forged = `${SECRET_HANDLE_MARKER}:${JSON.stringify({
			...handle,
			marker: "eliza:secret-handle:v0",
		})}`;

		expect(parseSecretHandle(forged)).toBeNull();
	});

	it("returns null for non-object JSON bodies", () => {
		expect(parseSecretHandle(`${SECRET_HANDLE_MARKER}:null`)).toBeNull();
		expect(parseSecretHandle(`${SECRET_HANDLE_MARKER}:[1,2]`)).toBeNull();
	});
});

describe("secrets error taxonomy", () => {
	it("SecretsError carries message, code, and details", () => {
		const error = new SecretsError("boom", "SOME_CODE", { attempts: 2 });

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("SecretsError");
		expect(error.message).toBe("boom");
		expect(error.code).toBe("SOME_CODE");
		expect(error.details).toEqual({ attempts: 2 });
	});

	it("subclasses remain catchable as SecretsError", () => {
		const context = { level: "user" as const, agentId: "agent-1" };
		const errors = [
			new PermissionDeniedError("KEY", "read", context),
			new SecretNotFoundError("KEY", context),
			new ValidationError("KEY", "bad"),
			new EncryptionError("no key"),
			new StorageError("disk full"),
		];

		for (const error of errors) {
			expect(error).toBeInstanceOf(SecretsError);
			expect(error).toBeInstanceOf(Error);
		}
	});

	it("PermissionDeniedError formats action, key, and level", () => {
		const context = { level: "world" as const, agentId: "agent-1" };
		const error = new PermissionDeniedError("API_KEY", "share", context);

		expect(error.name).toBe("PermissionDeniedError");
		expect(error.code).toBe("PERMISSION_DENIED");
		expect(error.message).toBe(
			"Permission denied: cannot share secret 'API_KEY' at level 'world'",
		);
		expect(error.details).toEqual({
			key: "API_KEY",
			action: "share",
			context,
		});
	});

	it("SecretNotFoundError reports key and level", () => {
		const error = new SecretNotFoundError("MISSING", {
			level: "global",
			agentId: "agent-1",
		});

		expect(error.name).toBe("SecretNotFoundError");
		expect(error.code).toBe("SECRET_NOT_FOUND");
		expect(error.message).toBe("Secret 'MISSING' not found at level 'global'");
		expect(error.details?.key).toBe("MISSING");
	});

	it("ValidationError prefixes the key and merges details", () => {
		const withDetails = new ValidationError("TOKEN", "expired", {
			validatedAt: 123,
		});

		expect(withDetails.code).toBe("VALIDATION_FAILED");
		expect(withDetails.message).toBe(
			"Validation failed for secret 'TOKEN': expired",
		);
		expect(withDetails.details).toEqual({ key: "TOKEN", validatedAt: 123 });

		const withoutDetails = new ValidationError("TOKEN", "bad format");
		expect(withoutDetails.details).toEqual({ key: "TOKEN" });
	});

	it("EncryptionError and StorageError keep their codes and optional details", () => {
		const encryption = new EncryptionError("decrypt failed");
		expect(encryption.code).toBe("ENCRYPTION_ERROR");
		expect(encryption.details).toBeUndefined();

		const storage = new StorageError("write failed", { table: "secrets" });
		expect(storage.code).toBe("STORAGE_ERROR");
		expect(storage.details).toEqual({ table: "secrets" });
	});
});

describe("secret key pattern classification", () => {
	it("accepts conventional upper-snake keys starting with a letter", () => {
		expect(SECRET_KEY_PATTERN.test("OPENAI_API_KEY")).toBe(true);
		expect(SECRET_KEY_PATTERN.test("K1_NESTED_DIGITS")).toBe(true);
		expect(MAX_ACCESS_LOG_ENTRIES).toBeGreaterThan(0);
	});

	it("rejects lowercase, leading digit or underscore, and hyphens", () => {
		expect(SECRET_KEY_PATTERN.test("openai_key")).toBe(false);
		expect(SECRET_KEY_PATTERN.test("1UPPER")).toBe(false);
		expect(SECRET_KEY_PATTERN.test("_UNDERSCORE")).toBe(false);
		expect(SECRET_KEY_PATTERN.test("HAS-HYPHEN")).toBe(false);
	});
});
