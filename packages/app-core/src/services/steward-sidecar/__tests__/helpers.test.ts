/**
 * Exercises Steward sidecar helper contracts against real implementations without external services.
 */
import { describe, expect, it } from "vitest";
import {
  fingerprintRandomToken,
  generateApiKey,
  generateMasterPassword,
  resolveDataDir,
  sleep,
} from "../helpers.ts";

describe("resolveDataDir", () => {
  it("expands leading tilde to the home directory", () => {
    expect(resolveDataDir("~/data")).toMatch(/^\/.*\/data$/);
    expect(resolveDataDir("~/data")).not.toContain("~");
  });

  it("leaves non-tilde paths unchanged", () => {
    expect(resolveDataDir("/abs/path")).toBe("/abs/path");
    expect(resolveDataDir("rel/path")).toBe("rel/path");
  });
});

describe("generateApiKey", () => {
  it("produces a stw_ prefixed hex key", () => {
    const key = generateApiKey();
    expect(key.startsWith("stw_")).toBe(true);
    expect(key.length).toBe(4 + 64); // stw_ + 32 bytes hex
  });

  it("produces distinct keys across calls", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("generateMasterPassword", () => {
  it("produces a 64-char hex password", () => {
    const pwd = generateMasterPassword();
    expect(pwd.length).toBe(64);
    expect(pwd).toMatch(/^[0-9a-f]+$/);
  });
});

describe("fingerprintRandomToken", () => {
  it("produces a 64-char sha256 hex digest", () => {
    const fp = fingerprintRandomToken("token-123");
    expect(fp.length).toBe(64);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic per token", () => {
    expect(fingerprintRandomToken("abc")).toBe(fingerprintRandomToken("abc"));
    expect(fingerprintRandomToken("abc")).not.toBe(
      fingerprintRandomToken("abd"),
    );
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});
