// @vitest-environment jsdom

/**
 * Unit coverage for `deriveShellRole` — the pure mapping from auth status to the
 * shell's canonical role (local/loopback authenticated → OWNER, etc.).
 */

import { describe, expect, it } from "vitest";
import { deriveShellRole } from "./ShellRoleProvider.tsx";

describe("deriveShellRole", () => {
  it("maps local/loopback authenticated access to OWNER", () => {
    expect(
      deriveShellRole({ phase: "authenticated", access: { mode: "local" } }),
    ).toBe("OWNER");
  });

  it("maps an authenticated session/remote caller to USER", () => {
    expect(
      deriveShellRole({ phase: "authenticated", access: { mode: "session" } }),
    ).toBe("USER");
    expect(
      deriveShellRole({ phase: "authenticated", access: { mode: "bearer" } }),
    ).toBe("USER");
  });

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

  it("ignores an unknown server role and falls back to the mode interim", () => {
    expect(
      deriveShellRole({
        phase: "authenticated",
        access: { mode: "local", role: "wizard" },
      }),
    ).toBe("OWNER");
  });
});
