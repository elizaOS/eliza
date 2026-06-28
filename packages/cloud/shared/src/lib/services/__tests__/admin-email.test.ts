import { describe, expect, test } from "bun:test";
import { isElizaLabsAdminEmail } from "../admin";

// Admin gate: only @elizalabs.ai emails. The `@` anchor in the suffix is what
// stops look-alike-domain spoofing — pin it so it can't regress to a bare-domain
// `endsWith` (which `evil@notelizalabs.ai` would slip through).
describe("isElizaLabsAdminEmail", () => {
  test("accepts an @elizalabs.ai email (case-insensitive, trimmed)", () => {
    expect(isElizaLabsAdminEmail("user@elizalabs.ai")).toBe(true);
    expect(isElizaLabsAdminEmail("USER@ELIZALABS.AI")).toBe(true);
    expect(isElizaLabsAdminEmail("  user@elizalabs.ai  ")).toBe(true);
  });

  test("rejects non-admin + empty inputs", () => {
    expect(isElizaLabsAdminEmail("user@gmail.com")).toBe(false);
    expect(isElizaLabsAdminEmail(null)).toBe(false);
    expect(isElizaLabsAdminEmail(undefined)).toBe(false);
    expect(isElizaLabsAdminEmail("")).toBe(false);
  });

  test("rejects look-alike-domain spoofing", () => {
    expect(isElizaLabsAdminEmail("evil@notelizalabs.ai")).toBe(false);
    expect(isElizaLabsAdminEmail("user@elizalabs.ai.evil.com")).toBe(false);
    expect(isElizaLabsAdminEmail("elizalabs.ai@gmail.com")).toBe(false);
  });
});
