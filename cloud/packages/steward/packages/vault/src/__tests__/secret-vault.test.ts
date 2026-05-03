import { describe, expect, it } from "bun:test";
import { KeyStore } from "../keystore";
import { globToRegex, matchesGlob } from "../route-matcher";

const MASTER_PASSWORD = "test-secret-vault-master";

// ─── Encryption round-trip tests (no DB needed) ──────────────────────────────

describe("Secret encryption round-trip", () => {
  const keyStore = new KeyStore(MASTER_PASSWORD);

  it("encrypts and decrypts an API key", () => {
    const apiKey = "sk-ant-abc123-def456-ghi789";
    const encrypted = keyStore.encrypt(apiKey);

    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();
    expect(encrypted.salt).toBeTruthy();

    // Ciphertext should not contain the original value
    expect(encrypted.ciphertext).not.toContain(apiKey);

    const decrypted = keyStore.decrypt(encrypted);
    expect(decrypted).toBe(apiKey);
  });

  it("encrypts and decrypts a complex credential (JSON)", () => {
    const credential = JSON.stringify({
      client_id: "app-123",
      client_secret: "super-secret-value",
      refresh_token: "rt_abcdef",
    });

    const encrypted = keyStore.encrypt(credential);
    const decrypted = keyStore.decrypt(encrypted);
    expect(decrypted).toBe(credential);
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(credential));
  });

  it("encrypts and decrypts an empty string", () => {
    const encrypted = keyStore.encrypt("");
    const decrypted = keyStore.decrypt(encrypted);
    expect(decrypted).toBe("");
  });

  it("encrypts and decrypts a long value", () => {
    const longValue = "x".repeat(10000);
    const encrypted = keyStore.encrypt(longValue);
    const decrypted = keyStore.decrypt(encrypted);
    expect(decrypted).toBe(longValue);
  });

  it("produces different ciphertexts for same value (random IV + salt)", () => {
    const value = "sk-test-key-12345";
    const enc1 = keyStore.encrypt(value);
    const enc2 = keyStore.encrypt(value);

    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.salt).not.toBe(enc2.salt);

    // Both decrypt to same value
    expect(keyStore.decrypt(enc1)).toBe(value);
    expect(keyStore.decrypt(enc2)).toBe(value);
  });

  it("fails to decrypt with wrong master password", () => {
    const value = "sk-test-key-12345";
    const encrypted = keyStore.encrypt(value);

    const wrongKeyStore = new KeyStore("wrong-password");
    expect(() => wrongKeyStore.decrypt(encrypted)).toThrow();
  });

  it("fails to decrypt with tampered ciphertext", () => {
    const value = "sk-test-key-12345";
    const encrypted = keyStore.encrypt(value);

    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext}ff` };
    expect(() => keyStore.decrypt(tampered)).toThrow();
  });

  it("fails to decrypt with tampered auth tag", () => {
    const value = "sk-test-key-12345";
    const encrypted = keyStore.encrypt(value);

    const tampered = { ...encrypted, tag: "00".repeat(16) };
    expect(() => keyStore.decrypt(tampered)).toThrow();
  });
});

// ─── Route matching tests (pure functions, no DB) ─────────────────────────────

describe("Route matching — glob patterns", () => {
  it("matches exact host", () => {
    expect(matchesGlob("api.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(matchesGlob("api.openai.com", "api.anthropic.com")).toBe(false);
  });

  it("matches wildcard host", () => {
    expect(matchesGlob("api.anthropic.com", "*.anthropic.com")).toBe(true);
    expect(matchesGlob("staging.anthropic.com", "*.anthropic.com")).toBe(true);
    expect(matchesGlob("api.openai.com", "*.anthropic.com")).toBe(false);
  });

  it("matches wildcard-all", () => {
    expect(matchesGlob("anything.com", "*")).toBe(true);
    expect(matchesGlob("", "*")).toBe(true);
  });

  it("matches exact path", () => {
    expect(matchesGlob("/v1/chat/completions", "/v1/chat/completions")).toBe(true);
    expect(matchesGlob("/v1/embeddings", "/v1/chat/completions")).toBe(false);
  });

  it("matches wildcard path", () => {
    expect(matchesGlob("/v1/chat/completions", "/v1/*")).toBe(true);
    expect(matchesGlob("/v1/embeddings", "/v1/*")).toBe(true);
    expect(matchesGlob("/v2/chat", "/v1/*")).toBe(false);
  });

  it("matches complex patterns", () => {
    expect(matchesGlob("api.service.example.com", "*.service.*.com")).toBe(true);
    expect(matchesGlob("/api/v1/users/123/profile", "/api/v1/users/*")).toBe(true);
  });

  it("escapes regex special characters", () => {
    expect(matchesGlob("api.example.com", "api.example.com")).toBe(true);
    expect(matchesGlob("apixexamplexcom", "api.example.com")).toBe(false);
  });
});

describe("globToRegex", () => {
  it("converts simple pattern", () => {
    const re = globToRegex("*.com");
    expect(re.test("example.com")).toBe(true);
    expect(re.test("test.org")).toBe(false);
  });

  it("converts wildcard-only pattern", () => {
    const re = globToRegex("*");
    expect(re.test("anything")).toBe(true);
    expect(re.test("")).toBe(true);
  });

  it("handles dots correctly", () => {
    const re = globToRegex("api.example.com");
    expect(re.test("api.example.com")).toBe(true);
    expect(re.test("apixexamplexcom")).toBe(false);
  });
});
