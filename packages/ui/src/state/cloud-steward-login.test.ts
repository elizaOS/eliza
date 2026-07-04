// @vitest-environment jsdom

/**
 * The Steward login seam (`cloud-steward-login`): stored-JWT usability checks
 * (expiry parsing), launcher registration, and `launchStewardLogin` dispatch.
 * jsdom + real `localStorage`; JWTs are synthetic (unsigned) — no real Steward
 * service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasStewardLoginLauncher,
  hasUsableStoredStewardToken,
  launchStewardLogin,
  registerStewardLoginLauncher,
} from "./cloud-steward-login";

const STEWARD_TOKEN_KEY = "steward_session_token";

/** Build a minimal (unsigned) JWT whose payload carries the given `exp`. */
function makeJwt(expSecondsFromNow: number | null): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = enc({ alg: "none", typ: "JWT" });
  const payload = enc(
    expSecondsFromNow === null
      ? {}
      : { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow },
  );
  return `${header}.${payload}.sig`;
}

describe("cloud-steward-login seam", () => {
  beforeEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    vi.restoreAllMocks();
  });

  it("reports no launcher by default", () => {
    expect(hasStewardLoginLauncher()).toBe(false);
  });

  it("resolves immediately with an opaque stored token (device-code/Remote, no launcher call)", async () => {
    // Non-JWT opaque session tokens have no decodable `exp` → left to the legacy
    // flow (preserved), so they still short-circuit.
    localStorage.setItem(STEWARD_TOKEN_KEY, "opaque-device-code-token");
    const launcher = vi.fn(async () => ({ token: "launcher-jwt" }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      await expect(launchStewardLogin()).resolves.toEqual({
        token: "opaque-device-code-token",
      });
      expect(launcher).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("short-circuits on a still-valid Steward JWT (no launcher call)", async () => {
    const token = makeJwt(600);
    localStorage.setItem(STEWARD_TOKEN_KEY, token);
    const launcher = vi.fn(async () => ({ token: "launcher-jwt" }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      await expect(launchStewardLogin()).resolves.toEqual({ token });
      expect(launcher).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("forces re-auth on an expired Steward JWT (clears stale token, invokes launcher)", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    const launcher = vi.fn(async () => ({ token: "fresh-jwt" }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      await expect(launchStewardLogin()).resolves.toEqual({
        token: "fresh-jwt",
      });
      expect(launcher).toHaveBeenCalledTimes(1);
      // Stale token must be drained so it can't 401 later flows in a loop.
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    } finally {
      unregister();
    }
  });

  it("forces re-auth on a JWT expiring within the safety margin", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(5));
    const launcher = vi.fn(async () => ({ token: "fresh-jwt" }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      await expect(launchStewardLogin()).resolves.toEqual({
        token: "fresh-jwt",
      });
      expect(launcher).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("clears the stale token and throws when an expired JWT has no launcher", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    await expect(launchStewardLogin()).rejects.toThrow(
      /Steward login surface is not mounted/,
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("invokes the registered launcher when no token is stored", async () => {
    const launcher = vi.fn(async () => ({ token: "launcher-jwt" }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      await expect(launchStewardLogin()).resolves.toEqual({
        token: "launcher-jwt",
      });
      expect(launcher).toHaveBeenCalledTimes(1);
      expect(hasStewardLoginLauncher()).toBe(true);
    } finally {
      unregister();
    }
  });

  it("throws when no launcher is registered and no token is stored", async () => {
    await expect(launchStewardLogin()).rejects.toThrow(
      /Steward login surface is not mounted/,
    );
  });

  it("hasUsableStoredStewardToken mirrors the short-circuit rules", () => {
    // No token stored.
    expect(hasUsableStoredStewardToken()).toBe(false);
    // Still-valid JWT — usable.
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(600));
    expect(hasUsableStoredStewardToken()).toBe(true);
    // Expired JWT — NOT usable (would only be drained + rethrown launcher-less).
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    expect(hasUsableStoredStewardToken()).toBe(false);
    // Within the safety margin — NOT usable.
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(5));
    expect(hasUsableStoredStewardToken()).toBe(false);
    // Opaque device-code token (no decodable exp) — treated usable.
    localStorage.setItem(STEWARD_TOKEN_KEY, "opaque-device-code-token");
    expect(hasUsableStoredStewardToken()).toBe(true);
    // Checking must never drain the stored value.
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
      "opaque-device-code-token",
    );
  });

  it("unregister removes the launcher", () => {
    const unregister = registerStewardLoginLauncher(async () => ({
      token: "x",
    }));
    expect(hasStewardLoginLauncher()).toBe(true);
    unregister();
    expect(hasStewardLoginLauncher()).toBe(false);
  });
});
