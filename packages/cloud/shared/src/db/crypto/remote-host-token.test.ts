import { describe, expect, test } from "bun:test";
import { generateRemoteHostToken, hashRemoteHostToken } from "./remote-host-token";

describe("remote host tokens", () => {
  test("generates high-entropy tokens and stores only deterministic hashes", async () => {
    const first = generateRemoteHostToken();
    const second = generateRemoteHostToken();
    expect(first).toMatch(/^eliza_host_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    const digest = await hashRemoteHostToken(first);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(first);
    expect(await hashRemoteHostToken(first)).toBe(digest);
  });

  test("rejects malformed token material", async () => {
    await expect(hashRemoteHostToken("short")).rejects.toThrow("malformed");
  });
});
