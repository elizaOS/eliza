import { describe, expect, test } from "bun:test";

import {
  formatRecoveryCode,
  generateRecoveryCodes,
  InMemoryRecoveryCodeStore,
  normalize,
  unusedRecoveryCodeCount,
  verifyRecoveryCode,
} from "../recovery-codes";

const USER = "user-abc";

describe("recovery code formatting", () => {
  test("formatRecoveryCode groups into 5-char chunks separated by '-'", () => {
    expect(formatRecoveryCode("ABCDE23FGH")).toBe("ABCDE-23FGH");
  });

  test("normalize strips separators and uppercases", () => {
    expect(normalize("abcde-23fgh")).toBe("ABCDE23FGH");
    expect(normalize("ABCDE 23FGH")).toBe("ABCDE23FGH");
  });

  test("normalize rejects characters outside the alphabet", () => {
    // 'I', 'O', '0', '1' are intentionally absent
    expect(normalize("ABCDEI23FG")).toBe("");
    expect(normalize("ABCDE0FGHJ")).toBe("");
  });
});

describe("generateRecoveryCodes + verifyRecoveryCode", () => {
  test("generates the requested count, all distinct, valid alphabet", async () => {
    const store = new InMemoryRecoveryCodeStore();
    const codes = await generateRecoveryCodes(store, USER, 10);
    expect(codes).toHaveLength(10);
    const norms = codes.map(normalize);
    expect(new Set(norms).size).toBe(10);
    for (const n of norms) {
      expect(n).toMatch(/^[A-HJ-NP-Z2-9]{14}$/);
    }
  });

  test("legacy 10-char codes still verify (SEC-064 grace), new codes are 14 chars", async () => {
    const store = new InMemoryRecoveryCodeStore();
    // Simulate a pre-upgrade stored code: 10 chars, salted single SHA-256.
    const legacyRaw = "ABCDEFGHJK";
    const legacySalt = "SALTSALTSALTSALT";
    const { createHash } = await import("node:crypto");
    const legacyHash = createHash("sha256")
      .update(`${legacySalt}:${legacyRaw}`)
      .digest("hex");
    await store.replaceForUser(USER, [{ hash: legacyHash, salt: legacySalt }]);

    const legacy = await verifyRecoveryCode(store, USER, "ABCDE-FGHJK");
    expect(legacy.valid).toBe(true);

    const codes = await generateRecoveryCodes(store, USER, 1);
    expect(normalize(codes[0])).toHaveLength(14);
  });

  test("returns valid=true for any issued code, then refuses replay", async () => {
    const store = new InMemoryRecoveryCodeStore();
    const codes = await generateRecoveryCodes(store, USER, 5);
    const target = codes[2];
    const first = await verifyRecoveryCode(store, USER, target);
    expect(first.valid).toBe(true);
    const replay = await verifyRecoveryCode(store, USER, target);
    expect(replay.valid).toBe(false);
  });

  test("accepts the same code with different casing / separator placement", async () => {
    const store = new InMemoryRecoveryCodeStore();
    const codes = await generateRecoveryCodes(store, USER, 1);
    const noisy = codes[0].toLowerCase().replace(/-/g, " ");
    const result = await verifyRecoveryCode(store, USER, noisy);
    expect(result.valid).toBe(true);
  });

  test("rejects an unknown code without leaking which user it belongs to", async () => {
    const store = new InMemoryRecoveryCodeStore();
    await generateRecoveryCodes(store, USER, 3);
    const bogus = "ZZZZZ-ZZZZZ";
    const result = await verifyRecoveryCode(store, USER, bogus);
    expect(result.valid).toBe(false);
  });

  test("regenerating codes invalidates the prior batch", async () => {
    const store = new InMemoryRecoveryCodeStore();
    const first = await generateRecoveryCodes(store, USER, 4);
    await generateRecoveryCodes(store, USER, 4); // replace
    const oldCodeResult = await verifyRecoveryCode(store, USER, first[0]);
    expect(oldCodeResult.valid).toBe(false);
  });

  test("unusedRecoveryCodeCount decrements as codes are consumed", async () => {
    const store = new InMemoryRecoveryCodeStore();
    const codes = await generateRecoveryCodes(store, USER, 6);
    expect(await unusedRecoveryCodeCount(store, USER)).toBe(6);
    await verifyRecoveryCode(store, USER, codes[0]);
    await verifyRecoveryCode(store, USER, codes[1]);
    expect(await unusedRecoveryCodeCount(store, USER)).toBe(4);
  });

  test("count must be in [1, 32]", async () => {
    const store = new InMemoryRecoveryCodeStore();
    await expect(generateRecoveryCodes(store, USER, 0)).rejects.toThrow();
    await expect(generateRecoveryCodes(store, USER, 33)).rejects.toThrow();
    await expect(generateRecoveryCodes(store, USER, 1.5)).rejects.toThrow();
  });

  test("malformed input returns valid=false without throwing", async () => {
    const store = new InMemoryRecoveryCodeStore();
    await generateRecoveryCodes(store, USER, 1);
    expect((await verifyRecoveryCode(store, USER, "")).valid).toBe(false);
    expect((await verifyRecoveryCode(store, USER, "TOO-SHORT")).valid).toBe(
      false,
    );
    expect(
      (await verifyRecoveryCode(store, USER, "INVALID0LETTERS!")).valid,
    ).toBe(false);
  });
});
