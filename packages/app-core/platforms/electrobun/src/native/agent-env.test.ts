/** Exercises agent env behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  applyDesktopChildOwnershipEnv,
  applyDesktopDeferAppRoutesPolicy,
  applyWindowsNativeInferenceDefaults,
  resolveDesktopChildActiveRuntimeMode,
} from "./agent";

describe("applyDesktopChildOwnershipEnv", () => {
  it("projects persisted remote intent as an active local child", () => {
    const env: Record<string, string> = { ELIZA_STATE_DIR: "/tmp/eliza-test" };
    applyDesktopChildOwnershipEnv(env, 42, () =>
      JSON.stringify({
        deploymentTarget: {
          runtime: "remote",
          remoteApiBase: "http://127.0.0.1:2250",
        },
      }),
    );
    expect(env.ELIZA_ACTIVE_API_RUNTIME_MODE).toBe("local");
    expect(env.ELIZA_DESKTOP_PARENT_PID).toBe("42");
  });

  it("preserves persisted local-only intent for an embedded child", () => {
    const env: Record<string, string> = { ELIZA_STATE_DIR: "/tmp/eliza-test" };
    applyDesktopChildOwnershipEnv(env, 42, () =>
      JSON.stringify({ cloud: { enabled: false } }),
    );
    expect(env.ELIZA_ACTIVE_API_RUNTIME_MODE).toBe("local-only");
  });

  it("defaults only absent first-run config and rejects broken config", () => {
    expect(
      resolveDesktopChildActiveRuntimeMode({}, () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).toBe("local");
    expect(() =>
      resolveDesktopChildActiveRuntimeMode({}, () => "{broken"),
    ).toThrow();
    expect(() =>
      resolveDesktopChildActiveRuntimeMode({}, () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).toThrow(/denied/);
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
