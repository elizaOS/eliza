/** Verifies TOTP against public RFC vectors and exercises encoding and replay windows deterministically. */
import { describe, expect, test } from "bun:test";

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotp,
  generateTotpSecret,
  verifyTotp,
} from "../totp";

// RFC 6238 reference vectors — TOTP with SHA-1, key = ASCII "12345678901234567890"
// (base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ). Spec table values are 8-digit;
// we use a 6-digit production config, so we expect the last 6 of each row.
//
// time (s)    | T (hex)     | reference 6-digit (last 6 of the 8-digit RFC value)
// 59          | 0000000000000001 | 287082
// 1111111109  | 00000000023523EC | 081804
// 1111111111  | 00000000023523ED | 050471
// 1234567890  | 000000000273EF07 | 005924
// 2000000000  | 0000000003F940AA | 279037
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow public RFC 6238 test vector

describe("base32", () => {
  test("encode/decode round-trips arbitrary bytes", () => {
    for (const len of [1, 5, 10, 20, 32]) {
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      const decoded = base32Decode(base32Encode(bytes));
      expect(decoded.length).toBe(bytes.length);
      for (let i = 0; i < bytes.length; i++) expect(decoded[i]).toBe(bytes[i]);
    }
  });

  test("decode tolerates lowercase, whitespace, and padding", () => {
    const upper = base32Encode(new Uint8Array([1, 2, 3, 4, 5]));
    const noisy = upper.toLowerCase().split("").join(" ") + "===";
    const back = base32Decode(noisy);
    expect(Array.from(back)).toEqual([1, 2, 3, 4, 5]);
  });

  test("decode rejects invalid characters", () => {
    expect(() => base32Decode("ABCDE1XYZ")).toThrow();
    expect(() => base32Decode("!!!!")).toThrow();
  });
});

describe("TOTP (RFC 6238)", () => {
  test("matches RFC 6238 reference vectors at time=59s", async () => {
    const code = await generateTotp(RFC_SECRET, { time: 59_000 });
    expect(code).toBe("287082");
  });

  test("matches RFC 6238 reference vector at time=1111111109s", async () => {
    const code = await generateTotp(RFC_SECRET, { time: 1_111_111_109_000 });
    expect(code).toBe("081804");
  });

  test("matches RFC 6238 reference vector at time=1234567890s", async () => {
    const code = await generateTotp(RFC_SECRET, { time: 1_234_567_890_000 });
    expect(code).toBe("005924");
  });

  test("matches RFC 6238 reference vector at time=2000000000s", async () => {
    const code = await generateTotp(RFC_SECRET, { time: 2_000_000_000_000 });
    expect(code).toBe("279037");
  });

  test("verifyTotp accepts the current step code", async () => {
    const t = 1_700_000_000_000;
    const code = await generateTotp(RFC_SECRET, { time: t });
    const result = await verifyTotp(RFC_SECRET, code, { time: t });
    expect(result.valid).toBe(true);
    expect(result.drift).toBe(0);
  });

  test("verifyTotp tolerates ±1 step within the window", async () => {
    const t = 1_700_000_000_000;
    const prev = await generateTotp(RFC_SECRET, { time: t - 30_000 });
    const next = await generateTotp(RFC_SECRET, { time: t + 30_000 });
    const r1 = await verifyTotp(RFC_SECRET, prev, { time: t, windowSteps: 1 });
    expect(r1.valid).toBe(true);
    expect(r1.drift).toBe(-1);
    const r2 = await verifyTotp(RFC_SECRET, next, { time: t, windowSteps: 1 });
    expect(r2.valid).toBe(true);
    expect(r2.drift).toBe(1);
  });

  test("verifyTotp rejects codes outside the window", async () => {
    const t = 1_700_000_000_000;
    const distant = await generateTotp(RFC_SECRET, { time: t - 5 * 30_000 });
    const r = await verifyTotp(RFC_SECRET, distant, {
      time: t,
      windowSteps: 1,
    });
    expect(r.valid).toBe(false);
  });

  test("verifyTotp rejects malformed codes without throwing", async () => {
    expect((await verifyTotp(RFC_SECRET, "abcdef")).valid).toBe(false);
    expect((await verifyTotp(RFC_SECRET, "12345")).valid).toBe(false);
    expect((await verifyTotp(RFC_SECRET, "1234567")).valid).toBe(false);
    expect((await verifyTotp(RFC_SECRET, "")).valid).toBe(false);
  });

  test("generateTotpSecret produces a base32-decodable 20-byte secret", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(s).length).toBe(20);
    // Two consecutive draws differ with overwhelming probability.
    expect(s).not.toBe(generateTotpSecret());
  });

  test("buildOtpauthUri produces a spec-compliant URI", () => {
    const uri = buildOtpauthUri({
      issuer: "Steward",
      accountName: "alice@example.com",
      secret: "JBSWY3DPEHPK3PXP",
    });
    expect(uri.startsWith("otpauth://totp/Steward:alice%40example.com")).toBe(
      true,
    );
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Steward");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  test("buildOtpauthUri URL-encodes issuer and account containing special chars", () => {
    const uri = buildOtpauthUri({
      issuer: "My Co/Steward",
      accountName: "a+b@example.com",
      secret: "JBSWY3DPEHPK3PXP",
    });
    expect(uri).toContain("My%20Co%2FSteward");
    expect(uri).toContain("a%2Bb%40example.com");
  });

  test("strips adversarial base32 padding without regex backtracking", () => {
    const uri = buildOtpauthUri({
      issuer: "Steward",
      accountName: "alice@example.com",
      secret: `JBSWY3DPEHPK3PXP${"=".repeat(200_000)}`,
    });
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP&");
    expect(() =>
      buildOtpauthUri({
        issuer: "Steward",
        accountName: "alice@example.com",
        secret: `JBSWY3DPEHPK3PXP${"=".repeat(200_000)}!`,
      }),
    ).toThrow("invalid character");
  });
});
