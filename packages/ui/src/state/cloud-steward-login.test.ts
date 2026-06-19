// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasStewardLoginLauncher,
  launchStewardLogin,
  registerStewardLoginLauncher,
} from "./cloud-steward-login";

const STEWARD_TOKEN_KEY = "steward_session_token";

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

  it("resolves immediately with the stored Steward token (no launcher call)", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "existing-jwt");
    const launcher = vi.fn(async () => ({ token: "launcher-jwt" }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      await expect(launchStewardLogin()).resolves.toEqual({
        token: "existing-jwt",
      });
      expect(launcher).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
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

  it("unregister removes the launcher", () => {
    const unregister = registerStewardLoginLauncher(async () => ({
      token: "x",
    }));
    expect(hasStewardLoginLauncher()).toBe(true);
    unregister();
    expect(hasStewardLoginLauncher()).toBe(false);
  });
});
