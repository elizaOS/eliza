// #13624: the capture layer's `captureBackendLog` hardcoded port 31337 and all
// six desktop/mobile capture callers pass NO port — so when the dev/capture
// orchestrator auto-shifts the backend port (parallel agent-worktree stacks
// advertise the shifted port via ELIZA_API_PORT / ELIZA_PORT), the backend-log
// pull silently probed 31337, got nothing, returned null, and the capture run
// still finished GREEN with a MISSING log artifact. `resolveBackendLogPort`
// honors the orchestrator env so the log is pulled from the RIGHT backend.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKEND_LOG_PORT,
  resolveBackendLogPort,
} from "./issue-evidence.mjs";

describe("resolveBackendLogPort (#13624)", () => {
  it("falls back to the built-in default when no orchestrator env is set", () => {
    // REGRESSION GUARD: the old hardcoded `port = 31337` default silently
    // probed 31337 regardless of a shifted stack. An empty env legitimately
    // resolves to the default — but a SET env must now win (cases below).
    expect(resolveBackendLogPort({})).toBe(DEFAULT_BACKEND_LOG_PORT);
    expect(DEFAULT_BACKEND_LOG_PORT).toBe(31337);
  });

  it("honors ELIZA_API_PORT (the orchestrator's auto-shifted port)", () => {
    // The exact fix: a port-shifted parallel stack sets ELIZA_API_PORT; the
    // old hardcoded 31337 ignored it and shipped no log. Now it wins.
    expect(resolveBackendLogPort({ ELIZA_API_PORT: "41337" })).toBe(41337);
  });

  it("honors ELIZA_PORT when ELIZA_API_PORT is unset", () => {
    expect(resolveBackendLogPort({ ELIZA_PORT: "38080" })).toBe(38080);
  });

  it("prefers ELIZA_API_PORT over ELIZA_PORT (first-wins precedence)", () => {
    // Mirrors DESKTOP_API_PORT_KEYS order in packages/shared/src/runtime-env.ts.
    expect(
      resolveBackendLogPort({ ELIZA_API_PORT: "41337", ELIZA_PORT: "38080" }),
    ).toBe(41337);
  });

  it("skips a blank/whitespace ELIZA_API_PORT and falls through to ELIZA_PORT", () => {
    expect(
      resolveBackendLogPort({ ELIZA_API_PORT: "   ", ELIZA_PORT: "38080" }),
    ).toBe(38080);
  });

  it("ignores a non-numeric/out-of-range env value rather than coercing it", () => {
    // A garbage/invalid port must NOT silently become 31337-via-NaN or a
    // nonsense port; it is ignored so the next key (or default) applies.
    for (const bad of ["not-a-port", "3000abc", "-1", "0", "1.5", "99999999"]) {
      expect(resolveBackendLogPort({ ELIZA_API_PORT: bad })).toBe(
        DEFAULT_BACKEND_LOG_PORT,
      );
    }
    // Invalid ELIZA_API_PORT falls through to a valid ELIZA_PORT.
    expect(
      resolveBackendLogPort({ ELIZA_API_PORT: "bogus", ELIZA_PORT: "38080" }),
    ).toBe(38080);
  });

  it("accepts the boundary port 65535 and rejects 65536", () => {
    expect(resolveBackendLogPort({ ELIZA_API_PORT: "65535" })).toBe(65535);
    expect(resolveBackendLogPort({ ELIZA_API_PORT: "65536" })).toBe(
      DEFAULT_BACKEND_LOG_PORT,
    );
  });
});
