/** Exercises agent env behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  applyDesktopChildOwnershipEnv,
  applyDesktopDeferAppRoutesPolicy,
  applyWindowsNativeInferenceDefaults,
  resolveDesktopChildActiveRuntimeMode,
} from "./agent";

describe("applyDesktopChildOwnershipEnv", () => {
  it("pins the active API mode and parent lease for an embedded child", () => {
    const env: Record<string, string> = {
      ELIZA_ACTIVE_API_RUNTIME_MODE: "remote",
      ELIZA_DESKTOP_PARENT_PID: "999",
    };

    applyDesktopChildOwnershipEnv(env, 42);

    expect(env.ELIZA_ACTIVE_API_RUNTIME_MODE).toBe("local");
    expect(env.ELIZA_DESKTOP_PARENT_PID).toBe("42");
  });

  it("preserves persisted local-only intent for an embedded child", () => {
    const env: Record<string, string> = {
      ELIZA_STATE_DIR: "/tmp/eliza-desktop-local-only",
    };

    applyDesktopChildOwnershipEnv(env, 42, () =>
      JSON.stringify({
        deploymentTarget: {
          runtime: "remote",
          remoteApiBase: "http://127.0.0.1:2250",
        },
        cloud: { enabled: false },
      }),
    );

    expect(env.ELIZA_ACTIVE_API_RUNTIME_MODE).toBe("local-only");
    expect(env.ELIZA_DESKTOP_PARENT_PID).toBe("42");
  });

  it("keeps an explicit local-only process signal when config is unavailable", () => {
    expect(
      resolveDesktopChildActiveRuntimeMode(
        { ELIZA_ACTIVE_API_RUNTIME_MODE: "local-only" },
        () => {
          throw new Error("config unavailable");
        },
      ),
    ).toBe("local-only");
  });

  it("uses the direct-build local default only for an absent first-run config", () => {
    expect(
      resolveDesktopChildActiveRuntimeMode(
        { ELIZA_STATE_DIR: "/tmp/eliza-desktop-first-run" },
        () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      ),
    ).toBe("local");
  });

  it("rejects malformed persisted config instead of exposing local routes", () => {
    expect(() =>
      resolveDesktopChildActiveRuntimeMode(
        { ELIZA_STATE_DIR: "/tmp/eliza-desktop-malformed" },
        () => "{ not-json",
      ),
    ).toThrow();
  });

  it("surfaces unreadable persisted config instead of treating it as absent", () => {
    const unreadable = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    expect(() =>
      resolveDesktopChildActiveRuntimeMode(
        { ELIZA_STATE_DIR: "/tmp/eliza-desktop-unreadable" },
        () => {
          throw unreadable;
        },
      ),
    ).toThrow(unreadable);
  });
});

describe("applyWindowsNativeInferenceDefaults", () => {
  it("sets Windows native inference guards for the child runtime", () => {
    const env: Record<string, string> = {};

    applyWindowsNativeInferenceDefaults(env, "win32");

    expect(env.ELIZA_DISABLE_LOCAL_EMBEDDINGS).toBeUndefined();
    expect(env.GGML_NO_BACKTRACE).toBe("1");
  });

  it("preserves an explicit GGML_NO_BACKTRACE value", () => {
    const env: Record<string, string> = {
      GGML_NO_BACKTRACE: "custom",
    };

    applyWindowsNativeInferenceDefaults(env, "win32");

    expect(env.GGML_NO_BACKTRACE).toBe("custom");
  });

  it("does not mutate non-Windows child env", () => {
    const env: Record<string, string> = {};

    applyWindowsNativeInferenceDefaults(env, "linux");

    expect(env).toEqual({});
  });
});

describe("applyDesktopDeferAppRoutesPolicy", () => {
  it("defaults ELIZA_DEFER_APP_ROUTES=1 for the desktop child", () => {
    const env: Record<string, string> = {};

    applyDesktopDeferAppRoutesPolicy(env);

    expect(env.ELIZA_DEFER_APP_ROUTES).toBe("1");
  });

  it("preserves an explicit ELIZA_DEFER_APP_ROUTES value", () => {
    const env: Record<string, string> = { ELIZA_DEFER_APP_ROUTES: "0" };

    applyDesktopDeferAppRoutesPolicy(env);

    expect(env.ELIZA_DEFER_APP_ROUTES).toBe("0");
  });
});
