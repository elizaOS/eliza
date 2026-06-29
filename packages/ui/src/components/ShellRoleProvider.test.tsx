// @vitest-environment jsdom

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
});
