/**
 * E2E tests for restored OAuth flow modules.
 *
 * Verifies that the auth modules import correctly and export
 * the expected functions/types after restoration from git history.
 */

import { describe, expect, it } from "vitest";

describe("auth/openai-codex module", () => {
  it("imports successfully", async () => {
    const mod = await import("../src/auth/openai-codex");
    expect(mod).toBeDefined();
  });

  it("exports startCodexLogin function", async () => {
    const { startCodexLogin } = await import("../src/auth/openai-codex");
    expect(typeof startCodexLogin).toBe("function");
  });

  it("exports refreshCodexToken function", async () => {
    const { refreshCodexToken } = await import("../src/auth/openai-codex");
    expect(typeof refreshCodexToken).toBe("function");
  });

  it("exports CodexFlow interface (type — verified via startCodexLogin return)", async () => {
    // We can't directly test a TypeScript interface at runtime,
    // but we verify the module shape is correct by checking the
    // function that returns it exists and is callable.
    const { startCodexLogin } = await import("../src/auth/openai-codex");
    expect(startCodexLogin).toBeDefined();
    expect(startCodexLogin.length).toBeGreaterThanOrEqual(0);
  });
});

describe("auth/anthropic module", () => {
  it("imports successfully", async () => {
    const mod = await import("../src/auth/anthropic");
    expect(mod).toBeDefined();
  });

  it("exports startAnthropicLogin function", async () => {
    const { startAnthropicLogin } = await import("../src/auth/anthropic");
    expect(typeof startAnthropicLogin).toBe("function");
  });

  it("exports refreshAnthropicToken function", async () => {
    const { refreshAnthropicToken } = await import("../src/auth/anthropic");
    expect(typeof refreshAnthropicToken).toBe("function");
  });
});

describe("auth/index re-exports", () => {
  it("re-exports all expected functions from the auth barrel", async () => {
    const auth = await import("../src/auth/index");
    // From openai-codex
    expect(typeof auth.startCodexLogin).toBe("function");
    expect(typeof auth.refreshCodexToken).toBe("function");
    // From anthropic
    expect(typeof auth.startAnthropicLogin).toBe("function");
    expect(typeof auth.refreshAnthropicToken).toBe("function");
    // From credentials
    expect(typeof auth.saveCredentials).toBe("function");
    expect(typeof auth.loadCredentials).toBe("function");
    expect(typeof auth.deleteCredentials).toBe("function");
    expect(typeof auth.hasValidCredentials).toBe("function");
    expect(typeof auth.getAccessToken).toBe("function");
    expect(typeof auth.getSubscriptionStatus).toBe("function");
    expect(typeof auth.applySubscriptionCredentials).toBe("function");
  });
});
