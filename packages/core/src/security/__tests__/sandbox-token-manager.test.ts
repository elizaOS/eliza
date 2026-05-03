import { beforeEach, describe, expect, it } from "vitest";
import {
	SANDBOX_TOKEN_PREFIX,
	SandboxTokenManager,
} from "../sandbox-token-manager";

describe("SandboxTokenManager", () => {
	let tm: SandboxTokenManager;

	beforeEach(() => {
		tm = new SandboxTokenManager();
	});

	describe("registerSecret", () => {
		it("should generate a token with the correct prefix", () => {
			const token = tm.registerSecret("OPENAI_API_KEY", "sk-real-key-123");
			expect(token.startsWith(SANDBOX_TOKEN_PREFIX)).toBe(true);
		});

		it("should return deterministic token for same key", () => {
			const t1 = tm.registerSecret("KEY", "value1");
			const t2 = tm.registerSecret("KEY", "value1");
			expect(t1).toBe(t2);
		});

		it("should keep same token when value changes for same key", () => {
			const t1 = tm.registerSecret("KEY", "old-value");
			const t2 = tm.registerSecret("KEY", "new-value");
			expect(t1).toBe(t2);
			expect(tm.resolveToken(t1)).toBe("new-value");
		});

		it("should generate different tokens for different keys", () => {
			const t1 = tm.registerSecret("KEY_A", "value");
			const t2 = tm.registerSecret("KEY_B", "value");
			expect(t1).not.toBe(t2);
		});

		it("should infer secret type from key name", () => {
			tm.registerSecret("OPENAI_API_KEY", "sk-123");
			tm.registerSecret("EVM_PRIVATE_KEY", "0xabc");
			tm.registerSecret("OAUTH_TOKEN", "tok-xyz");
			tm.registerSecret("DB_PASSWORD", "pass123456");
			tm.registerSecret("SOME_SETTING", "val12345678");

			const t1 = tm.getTokenForKey("OPENAI_API_KEY");
			const t2 = tm.getTokenForKey("EVM_PRIVATE_KEY");
			const t3 = tm.getTokenForKey("OAUTH_TOKEN");
			const t4 = tm.getTokenForKey("DB_PASSWORD");
			const t5 = tm.getTokenForKey("SOME_SETTING");
			if (!t1 || !t2 || !t3 || !t4 || !t5) {
				throw new Error("Expected all tokens to be registered");
			}
			expect(tm.getMetadata(t1)?.secretType).toBe("api_key");
			expect(tm.getMetadata(t2)?.secretType).toBe("private_key");
			expect(tm.getMetadata(t3)?.secretType).toBe("oauth_token");
			expect(tm.getMetadata(t4)?.secretType).toBe("password");
			expect(tm.getMetadata(t5)?.secretType).toBe("other");
		});
	});

	describe("resolveToken", () => {
		it("should resolve registered token to real value", () => {
			const token = tm.registerSecret("KEY", "real-value");
			expect(tm.resolveToken(token)).toBe("real-value");
		});

		it("should return null for unknown token", () => {
			expect(tm.resolveToken("stok_unknown-uuid")).toBeNull();
		});
	});

	describe("getTokenForKey", () => {
		it("should return token for registered key", () => {
			const token = tm.registerSecret("MY_KEY", "val");
			expect(tm.getTokenForKey("MY_KEY")).toBe(token);
		});

		it("should return null for unregistered key", () => {
			expect(tm.getTokenForKey("MISSING")).toBeNull();
		});
	});

	describe("getTokenForValue", () => {
		it("should return token for registered value", () => {
			const token = tm.registerSecret("K", "my-secret-value");
			expect(tm.getTokenForValue("my-secret-value")).toBe(token);
		});

		it("should return null for unknown value", () => {
			expect(tm.getTokenForValue("not-registered")).toBeNull();
		});
	});

	describe("detokenizeString", () => {
		it("should replace tokens with real values", () => {
			const token = tm.registerSecret("KEY", "real-secret");
			const input = `Authorization: Bearer ${token}`;
			const output = tm.detokenizeString(input);
			expect(output).toBe("Authorization: Bearer real-secret");
		});

		it("should handle multiple tokens in one string", () => {
			const t1 = tm.registerSecret("KEY1", "secret1");
			const t2 = tm.registerSecret("KEY2", "secret2");
			const input = `${t1} and ${t2}`;
			const output = tm.detokenizeString(input);
			expect(output).toBe("secret1 and secret2");
		});

		it("should return input unchanged when no tokens present", () => {
			const input = "plain text with no tokens";
			expect(tm.detokenizeString(input)).toBe(input);
		});

		it("should return empty string for empty input", () => {
			expect(tm.detokenizeString("")).toBe("");
		});

		it("should handle special regex characters in real values", () => {
			const token = tm.registerSecret("KEY", "secret+with.special$chars");
			expect(tm.detokenizeString(token)).toBe("secret+with.special$chars");
		});
	});

	describe("tokenizeString", () => {
		it("should replace real values with tokens", () => {
			const token = tm.registerSecret("KEY", "my-api-key-12345");
			const input = "Response contained my-api-key-12345 in the body";
			const output = tm.tokenizeString(input);
			expect(output).toBe(`Response contained ${token} in the body`);
		});

		it("should process longest values first to avoid partial replacement", () => {
			tm.registerSecret("SHORT", "abc");
			const longToken = tm.registerSecret("LONG", "abcdef");
			const input = "value is abcdef";
			const output = tm.tokenizeString(input);
			expect(output).toContain(longToken);
			expect(output).not.toContain(`abc${longToken.slice(-3)}`); // no partial
		});

		it("should return empty string for empty input", () => {
			expect(tm.tokenizeString("")).toBe("");
		});
	});

	describe("isToken", () => {
		it("should return true for valid token format", () => {
			const token = tm.registerSecret("K", "v");
			expect(SandboxTokenManager.isToken(token)).toBe(true);
		});

		it("should return false for non-token strings", () => {
			expect(SandboxTokenManager.isToken("not-a-token")).toBe(false);
			expect(SandboxTokenManager.isToken("sk-real-key")).toBe(false);
		});
	});

	describe("lifecycle", () => {
		it("should track size correctly", () => {
			expect(tm.size).toBe(0);
			tm.registerSecret("A", "1");
			expect(tm.size).toBe(1);
			tm.registerSecret("B", "2");
			expect(tm.size).toBe(2);
		});

		it("should clear all mappings", () => {
			tm.registerSecret("A", "1");
			tm.registerSecret("B", "2");
			tm.clear();
			expect(tm.size).toBe(0);
			expect(tm.resolveToken(tm.getTokenForKey("A") ?? "")).toBeNull();
		});

		it("should list all registered keys", () => {
			tm.registerSecret("KEY_A", "val1");
			tm.registerSecret("KEY_B", "val2");
			const keys = tm.listKeys();
			expect(keys).toContain("KEY_A");
			expect(keys).toContain("KEY_B");
			expect(keys).toHaveLength(2);
		});
	});
});
