import { describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

// 用 node:crypto 替代 Web Crypto（vitest node 环境）
const subtle = {
  digest: async (alg: string, data: Uint8Array) => {
    const h = createHash("sha256").update(Buffer.from(data)).digest();
    return new Uint8Array(h);
  },
};
const getRandomValues = (arr: Uint8Array) => {
  const buf = randomBytes(arr.length);
  arr.set(buf);
  return arr;
};

vi.stubGlobal("crypto", { subtle, getRandomValues });

import { generatePKCE } from "./pkce.ts";

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

describe("generatePKCE", () => {
  it("produces a verifier and challenge", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier).toBeTruthy();
    expect(challenge).toBeTruthy();
    expect(verifier).not.toBe(challenge);
  });

  it("challenge is the SHA-256 of the verifier (base64url)", async () => {
    const { verifier, challenge } = await generatePKCE();
    const expected = b64urlEncode(
      new Uint8Array(createHash("sha256").update(verifier).digest()),
    );
    expect(challenge).toBe(expected);
  });

  it("generates distinct verifiers across calls (randomness)", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("uses URL-safe base64 without padding", async () => {
    const { verifier } = await generatePKCE();
    expect(verifier).not.toMatch(/[+/=]/);
  });
});
