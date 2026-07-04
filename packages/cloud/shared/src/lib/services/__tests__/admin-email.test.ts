// Exercises admin email behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { adminService, isElizaLabsAdminEmail } from "../admin";

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

describe("getAdminStatusForUser email verification gate", () => {
  test("grants super_admin to verified @elizalabs.ai email", async () => {
    await expect(
      adminService.getAdminStatusForUser({
        email: "admin@elizalabs.ai",
        email_verified: true,
      }),
    ).resolves.toEqual({ isAdmin: true, role: "super_admin" });
  });

  test("does not grant super_admin to unverified @elizalabs.ai email", async () => {
    await expect(
      adminService.getAdminStatusForUser({
        email: "attacker@elizalabs.ai",
        email_verified: false,
      }),
    ).resolves.toEqual({ isAdmin: false, role: null });

    await expect(
      adminService.getAdminStatusForUser({
        email: "attacker@elizalabs.ai",
        email_verified: null,
      }),
    ).resolves.toEqual({ isAdmin: false, role: null });
  });
});
