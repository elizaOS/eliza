/**
 * Unit coverage for the SQL runtime-migrator crypto utilities: djb2 hashing
 * for snapshot change detection, extended hashing for advisory locks, and
 * WebCrypto SHA-256. Deterministic — no database, real functions with fixed
 * vectors and boundary inputs.
 */
import { describe, expect, test } from "vitest";

import { extendedHash, sha256Async, simpleHash, stringToBigInt } from "./crypto-utils";

describe("simpleHash", () => {
  test("pins fixed vectors", () => {
    expect(simpleHash("")).toBe("00001505");
    expect(simpleHash("hello")).toBe("0a9cede7");
    expect(simpleHash("test")).toBe("7c73af33");
    expect(simpleHash("\u00e9")).toBe("0002b54c");
    expect(simpleHash("\u200b")).toBe("000295ae");
  });

  test("returns 8-char lower hex and is deterministic", () => {
    expect(simpleHash("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(simpleHash("hello")).toBe(simpleHash("hello"));
    expect(simpleHash("a".repeat(1000))).toMatch(/^[0-9a-f]{8}$/);
  });

  test("distinguishes different inputs and empty vs space", () => {
    expect(simpleHash("hello")).not.toBe(simpleHash("world"));
    expect(simpleHash("")).not.toBe(simpleHash(" "));
    expect(simpleHash("a")).not.toBe(simpleHash("b"));
  });

  test("handles long, unicode, and surrogate-adjacent inputs", () => {
    expect(simpleHash("\u00e9")).not.toBe(simpleHash("e"));
    expect(simpleHash("\u200b")).not.toBe(simpleHash(""));
    expect(simpleHash("a\u0300")).not.toBe(simpleHash("a"));
  });
});

describe("extendedHash", () => {
  test("pins fixed vectors", () => {
    expect(extendedHash("")).toBe("0000150500001eef0001991900036de1");
    expect(extendedHash("hello")).toBe("0a9cede725a2a4cd49bb1a7bd096c283");
    expect(extendedHash("test")).toBe("7c73af332fbaad99eaf3d62f0e1a8717");
  });

  test("returns 32-char hex and first chunk equals simpleHash", () => {
    expect(extendedHash("hello")).toMatch(/^[0-9a-f]{32}$/);
    expect(extendedHash("hello").slice(0, 8)).toBe(simpleHash("hello"));
    expect(extendedHash("")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("deterministic and distinguishes extended vs simple collision", () => {
    expect(extendedHash("test")).toBe(extendedHash("test"));
    expect(extendedHash("test")).not.toBe(extendedHash("test1"));
    expect(extendedHash("a")).not.toBe(extendedHash("b"));
  });

  test("mutation resistant across seeds", () => {
    const a = extendedHash("hello");
    const b = extendedHash("world");
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
    expect(a.slice(8, 16)).not.toBe(b.slice(8, 16));
  });
});

describe("sha256Async", () => {
  test("pins known SHA-256 vectors", async () => {
    expect(await sha256Async("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(await sha256Async("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    expect(await sha256Async("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
    expect(await sha256Async("a")).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    );
  });

  test("deterministic, 64-char hex, unicode byte semantics", async () => {
    expect(await sha256Async("a")).not.toBe(await sha256Async("b"));
    expect(await sha256Async("\u00e9")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"
    );
    expect(await sha256Async("\u200b")).toBe(
      "f4e48e664a603543865edc77bbc76dd1dd53dc9d0c30f651bbad7c8231091348"
    );
    expect((await sha256Async("hello")).length).toBe(64);
  });

  test("does not reject on empty or large input", async () => {
    await expect(sha256Async("")).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(sha256Async("x".repeat(5000))).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stringToBigInt", () => {
  test("pins fixed vectors and stays in 63-bit positive range", () => {
    expect(stringToBigInt("")).toBe(23111219027695n);
    expect(stringToBigInt("hello")).toBe(764747613770785997n);
    expect(stringToBigInt("test")).toBe(8967703917403745689n);
    expect(stringToBigInt("a")).toBe(762803371900078n);
  });

  test("positive, non-zero, 63-bit masked", () => {
    for (const s of ["", "a", "test", "lock", "0", "\u00e9"]) {
      const v = stringToBigInt(s);
      expect(typeof v).toBe("bigint");
      expect(v > 0n).toBe(true);
      expect(v <= 0x7fffffffffffffffn).toBe(true);
      expect(v !== 0n).toBe(true);
    }
  });

  test("deterministic and distinguishes inputs", () => {
    expect(stringToBigInt("hello")).toBe(stringToBigInt("hello"));
    expect(stringToBigInt("hello")).not.toBe(stringToBigInt("world"));
    expect(stringToBigInt("")).not.toBe(stringToBigInt(" "));
  });

  test("unicode and empty edge", () => {
    expect(stringToBigInt("\u00e9")).not.toBe(stringToBigInt("e"));
    expect(stringToBigInt("\u200b")).not.toBe(stringToBigInt(""));
    expect(stringToBigInt("a\u0300")).not.toBe(stringToBigInt("a"));
  });
});
