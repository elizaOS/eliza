// Exercises mesh-join auth-expired classification with deterministic fixtures.
import { describe, expect, it } from "vitest";
import {
  classifyMeshAuthStatus,
  isMeshAuthExpired,
  TS_AUTHKEY_EXPIRED_EXIT_CODE,
  TS_AUTHKEY_EXPIRED_MARKER_BASENAME,
} from "./headscale-auth-status";

/**
 * The entrypoint and the control plane must agree on the exact signals that
 * mean "this container is crash-looping on an expired/consumed mesh auth key
 * and needs re-keying, not a generic restart." These tests pin that contract:
 * the distinct exit code, the marker file, and the auth-failure log phrasings —
 * and prove the classifier NEVER promotes an unrelated failure to auth_expired.
 */
describe("classifyMeshAuthStatus", () => {
  it("pins the shared entrypoint contract constants", () => {
    // Must stay in lockstep with TS_AUTHKEY_EXPIRED_EXIT_CODE / the marker path
    // in packages/app-core/scripts/docker-entrypoint.sh.
    expect(TS_AUTHKEY_EXPIRED_EXIT_CODE).toBe(78);
    expect(TS_AUTHKEY_EXPIRED_MARKER_BASENAME).toBe("authkey-expired");
  });

  it("flags the distinct entrypoint exit code", () => {
    expect(classifyMeshAuthStatus({ exitCode: TS_AUTHKEY_EXPIRED_EXIT_CODE })).toBe("auth_expired");
    expect(isMeshAuthExpired({ exitCode: 78 })).toBe(true);
  });

  it("flags the marker file even when logs have rotated away", () => {
    expect(classifyMeshAuthStatus({ markerPresent: true, logs: "" })).toBe("auth_expired");
  });

  it.each([
    "Received error: authkey expired",
    "The last login error was: authkey expired",
    "authkey already used",
    "invalid key",
    '{"AuthURL":"https://headscale.example/register/node","BackendState":"NeedsLogin"}',
    '{"BackendState":"NeedsMachineAuth"}',
    "RegisterReq: machineAuthorized=false; authURL=true",
    "FATAL: ... node needs re-keying",
  ])("flags auth-failure log phrasing: %s", (line) => {
    expect(classifyMeshAuthStatus({ logs: `boot\n${line}\nmore` })).toBe("auth_expired");
  });

  it("is case-insensitive on log matching", () => {
    expect(classifyMeshAuthStatus({ logs: "AUTHKEY EXPIRED" })).toBe("auth_expired");
  });

  it.each(['{"BackendState":"NeedsLogin"}', "RegisterReq: machineAuthorized=false; authURL=false"])(
    "does not classify transient fresh-daemon state as rejected auth: %s",
    (line) => {
      expect(classifyMeshAuthStatus({ logs: line })).toBe("unknown");
    },
  );

  it("returns unknown for a healthy / unrelated failure (never a false re-key)", () => {
    expect(classifyMeshAuthStatus({ exitCode: 0, logs: "listening on :2138" })).toBe("unknown");
    expect(classifyMeshAuthStatus({ exitCode: 1, logs: "OOMKilled" })).toBe("unknown");
    expect(classifyMeshAuthStatus({})).toBe("unknown");
    expect(isMeshAuthExpired({ exitCode: 137 })).toBe(false);
  });

  it("does not treat a benign 'key' mention without a failure phrase as expired", () => {
    // Guards against over-broad matching: 'JWT_SECRET key loaded' must not trip.
    expect(classifyMeshAuthStatus({ logs: "loaded signing key ok" })).toBe("unknown");
  });

  it("does not treat an empty AuthURL in an ordinary status payload as interactive auth", () => {
    expect(classifyMeshAuthStatus({ logs: '{"AuthURL":"","BackendState":"Starting"}' })).toBe(
      "unknown",
    );
  });

  it("prefers positive evidence: marker present wins even with exitCode 0", () => {
    // A container can exit 0 on SIGTERM after the marker was written; the marker
    // is still the authoritative needs-re-key signal.
    expect(classifyMeshAuthStatus({ exitCode: 0, markerPresent: true })).toBe("auth_expired");
  });
});
