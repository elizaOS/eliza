import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pbkdf2Sync: vi.fn(() => Buffer.alloc(32, 7)),
  randomBytes: vi.fn((size: number) => Buffer.alloc(size, 1)),
  createCipheriv: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  pbkdf2Sync: (...a: unknown[]) => mocks.pbkdf2Sync(...a),
  randomBytes: (...a: unknown[]) => mocks.randomBytes(...a),
  createCipheriv: (...a: unknown[]) => mocks.createCipheriv(...a),
}));

import {
  buildElizaAgentArchive,
  MIN_PASSWORD_LENGTH,
} from "./archive-format.ts";

function fakeCipher() {
  return {
    update: vi.fn(() => Buffer.from("cipher")),
    final: vi.fn(() => Buffer.alloc(0)),
    getAuthTag: vi.fn(() => Buffer.alloc(16, 9)),
  };
}

describe("buildElizaAgentArchive", () => {
  beforeEach(() => {
    mocks.randomBytes.mockClear();
    mocks.createCipheriv.mockClear();
    mocks.pbkdf2Sync.mockClear();
  });

  it("rejects short passwords", () => {
    expect(() => buildElizaAgentArchive({}, "short")).toThrow(
      `at least ${MIN_PASSWORD_LENGTH} characters`,
    );
    expect(() => buildElizaAgentArchive({}, "")).toThrow();
  });

  it("builds a V1 archive with magic header and fields", () => {
    mocks.randomBytes.mockClear();
    mocks.createCipheriv.mockReturnValue(fakeCipher());
    const archive = buildElizaAgentArchive({ name: "x" }, "password-123456");
    // 15 magic + 4 iterations + 32 salt + 12 iv + 16 tag + ciphertext
    expect(archive.length).toBe(15 + 4 + 32 + 12 + 16 + 6);
    expect(archive.subarray(0, 15).toString()).toBe("ELIZA_AGENT_V1\n");
    expect(archive.readUInt32BE(15)).toBe(600_000);
    expect(mocks.pbkdf2Sync).toHaveBeenCalledWith(
      "password-123456",
      expect.any(Buffer),
      600_000,
      32,
      "sha256",
    );
    expect(mocks.createCipheriv).toHaveBeenCalledWith(
      "aes-256-gcm",
      expect.any(Buffer),
      expect.any(Buffer),
    );
  });

  it("gzip-compresses the JSON payload before encryption", () => {
    mocks.randomBytes.mockClear();
    mocks.createCipheriv.mockReturnValue(fakeCipher());
    buildElizaAgentArchive({ a: 1 }, "password-123456");
    // randomBytes 调用顺序：salt(32) → iv(12)
    expect(mocks.randomBytes).toHaveBeenCalledTimes(2);
    expect(mocks.createCipheriv).toHaveBeenCalledTimes(1);
  });
});
