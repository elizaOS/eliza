import { describe, expect, it } from "vitest";
import { generateRemoteHostToken, hashRemoteHostToken } from "./remote-host-token.js";

describe("remote-host-token", () => {
  it("generate produces prefixed token matching pattern", () => {
    const tok = generateRemoteHostToken();
    expect(tok.startsWith("rhost_v1_")).toBe(true);
    expect(tok.length).toBe("rhost_v1_".length + 43);
    expect(/^rhost_v1_[A-Za-z0-9_-]{43}$/.test(tok)).toBe(true);
  });

  it("hash returns sha256: hex for valid token", async () => {
    const tok = generateRemoteHostToken();
    const h = await hashRemoteHostToken(tok);
    expect(h.startsWith("sha256:")).toBe(true);
    expect(h.length).toBe("sha256:".length + 64);
    expect(/^sha256:[a-f0-9]{64}$/.test(h)).toBe(true);
  });

  it("hash rejects malformed token", async () => {
    await expect(hashRemoteHostToken("bad")).rejects.toThrow(/malformed/);
    await expect(hashRemoteHostToken("rhost_v1_short")).rejects.toThrow(/malformed/);
  });

  it("different tokens hash differently", async () => {
    const a = generateRemoteHostToken();
    const b = generateRemoteHostToken();
    expect(a).not.toBe(b);
    const ha = await hashRemoteHostToken(a);
    const hb = await hashRemoteHostToken(b);
    expect(ha).not.toBe(hb);
  });
});
