/** Verifies deriveShellRole through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for `deriveShellRole` — the pure mapping from auth status to the
 * shell's canonical role.
 */

import { describe, expect, it } from "vitest";
import { deriveShellRole } from "./ShellRoleProvider.tsx";

describe("deriveShellRole", () => {
  it.each(["local", "session", "bearer"])(
    "requires an authoritative role for %s access",
    (mode) => {
      expect(
        deriveShellRole({ phase: "authenticated", access: { mode } }),
      ).toBe("GUEST");
    },
  );

  it("fails low to GUEST for any non-authenticated phase", () => {
    expect(deriveShellRole({ phase: "loading" })).toBe("GUEST");
    expect(deriveShellRole({ phase: "unauthenticated" })).toBe("GUEST");
    expect(deriveShellRole({ phase: "server_unavailable" })).toBe("GUEST");
  });
  it("prefers the server-authoritative access.role when present (#9948)", () => {
    expect(
      deriveShellRole({
        phase: "authenticated",
        access: { mode: "session", role: "ADMIN" },
      }),
    ).toBe("ADMIN");
    expect(
      deriveShellRole({
        phase: "authenticated",
        access: { mode: "local", role: "USER" },
      }),
    ).toBe("USER");
    expect(
      deriveShellRole({
        phase: "authenticated",
        access: { mode: "bearer", role: "OWNER" },
      }),
    ).toBe("OWNER");
  });

  it("rejects an unknown server role", () => {
    expect(
      deriveShellRole({
        phase: "authenticated",
        access: { mode: "local", role: "wizard" },
      }),
    ).toBe("GUEST");
  });
});
