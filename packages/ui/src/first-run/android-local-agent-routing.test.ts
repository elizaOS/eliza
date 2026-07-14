/**
 * Covers Android local-agent route selection without mutating browser globals,
 * so changed-file coverage can run transport and token suites concurrently.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasStoredAndroidCloudSession,
  readAndroidLocalAgentRuntimeMode,
  resolveAndroidLocalAgentRuntimeMode,
  shouldRouteAndroidRequestToLocalAgent,
} from "./android-local-agent-routing";

describe("Android local-agent routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves persisted mode before cloud and build defaults", () => {
    expect(
      resolveAndroidLocalAgentRuntimeMode({
        persistedMode: " remote-mac ",
        hasCloudSession: true,
        androidBuildMode: "local",
        mobileBuildMode: "local",
      }),
    ).toBe("remote-mac");
  });

  it("resolves cloud before build defaults and Android before mobile", () => {
    expect(
      resolveAndroidLocalAgentRuntimeMode({
        hasCloudSession: true,
        androidBuildMode: "local",
      }),
    ).toBe("cloud");
    expect(
      resolveAndroidLocalAgentRuntimeMode({
        hasCloudSession: false,
        androidBuildMode: "local",
        mobileBuildMode: "cloud",
      }),
    ).toBe("local");
  });

  it("reads a build-stamped local mode without persisted browser state", () => {
    vi.stubEnv("VITE_ELIZA_ANDROID_RUNTIME_MODE", "local");

    expect(hasStoredAndroidCloudSession()).toBe(false);
    expect(readAndroidLocalAgentRuntimeMode()).toBe("local");
  });

  it("keeps IPC native while mode-gating legacy loopback HTTP", () => {
    expect(
      shouldRouteAndroidRequestToLocalAgent(
        "eliza-local-agent://ipc/api/status",
        "remote-mac",
      ),
    ).toBe(true);
    expect(
      shouldRouteAndroidRequestToLocalAgent(
        "http://127.0.0.1:31337/api/status",
        "remote-mac",
      ),
    ).toBe(false);
    expect(
      shouldRouteAndroidRequestToLocalAgent(
        "http://127.0.0.1:31337/api/status",
        "local",
      ),
    ).toBe(true);
  });
});
