/**
 * Exercises the mobile release preflight CLI in-process across its iOS and
 * Android release branches with deterministic toolchain and filesystem edges.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluateStagedIosSideloadBundle: vi.fn(() => ({
    ok: true,
    reason: "staged Cloud bundle is reachable",
  })),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "{}"),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  default: { spawnSync: mocks.spawnSync },
  spawnSync: mocks.spawnSync,
}));
vi.mock("node:fs", () => ({
  default: {
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
  },
}));
vi.mock("../../app-core/scripts/lib/mobile-lane-stamp.mjs", () => ({
  evaluateStagedIosSideloadBundle: mocks.evaluateStagedIosSideloadBundle,
}));

const originalArgv = [...process.argv];
const originalEnv = { ...process.env };
let importSequence = 0;

function successfulCommand(command: string, args: string[]) {
  if (command === "xcodebuild" && args.includes("-version")) {
    return { status: 0, stderr: "", stdout: "Xcode 26.0" };
  }
  if (command === "xcodebuild" && args.includes("-showsdks")) {
    return { status: 0, stderr: "", stdout: "iOS 26.0 -sdk iphoneos26.0" };
  }
  if (command === "xcodebuild" && args.includes("-list")) {
    return { status: 0, stderr: "", stdout: "Schemes:\n  App" };
  }
  return { status: 0, stderr: "", stdout: "available" };
}

async function runPreflight(args: string[]) {
  process.argv = ["node", "mobile-release-preflight.mjs", ...args];
  const scriptUrl = pathToFileURL(
    path.join(process.cwd(), "scripts/mobile-release-preflight.mjs"),
  );
  scriptUrl.searchParams.set("case", String(importSequence++));
  return import(scriptUrl.href);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  mocks.existsSync.mockReturnValue(true);
  mocks.readFileSync.mockReturnValue("{}");
  mocks.spawnSync.mockImplementation(successfulCommand);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code ?? 0})`);
  });
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("iOS release preflight", () => {
  it("accepts the Cloud-only App Store launch default", async () => {
    Object.assign(process.env, {
      APP_IDENTIFIER: "ai.elizaos.app",
      APP_STORE_APP_ID: "123456789",
      APPLE_ID: "release@example.com",
      APPLE_TEAM_ID: "TEAM",
      ELIZA_BUILD_VARIANT: "store",
      ITC_TEAM_ID: "ITC",
      MATCH_GIT_URL: "git@example.com:signing.git",
      MATCH_PASSWORD: "secret",
    });

    await expect(
      runPreflight(["--platform=ios", "--store"]),
    ).resolves.toBeDefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Eliza mobile ios store preflight"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("cloud-only store build"),
    );
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("fails an unmarked local-enabled store build that omits its engine", async () => {
    Object.assign(process.env, {
      APP_IDENTIFIER: "ai.elizaos.app",
      APP_STORE_APP_ID: "123456789",
      APPLE_ID: "release@example.com",
      APPLE_TEAM_ID: "TEAM",
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
      ELIZA_IOS_FULL_BUN_ENGINE: "0",
      ITC_TEAM_ID: "ITC",
      MATCH_GIT_URL: "git@example.com:signing.git",
      MATCH_PASSWORD: "secret",
    });

    await expect(runPreflight(["--platform=ios", "--store"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("store build would ship WITHOUT the Bun engine"),
    );
  });

  it("checks a staged iOS sideload bundle without rebuilding", async () => {
    await expect(
      runPreflight(["--platform=ios", "--staged-only"]),
    ).resolves.toBeDefined();
    expect(mocks.evaluateStagedIosSideloadBundle).toHaveBeenCalledWith({
      agentConfig: null,
      rendererManifest: {},
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Staged bundle agent reachability"),
    );
  });
});

describe("Android release preflight", () => {
  it("accepts a fully configured Play Store toolchain", async () => {
    Object.assign(process.env, {
      ANDROID_HOME: "/opt/android-sdk",
      ELIZAOS_KEYSTORE_PASSWORD: "secret",
      ELIZAOS_KEYSTORE_PATH: "/keys/release.jks",
      ELIZAOS_KEY_ALIAS: "release",
      ELIZAOS_KEY_PASSWORD: "secret",
      PLAY_STORE_SERVICE_ACCOUNT_JSON: "{}",
    });

    await expect(
      runPreflight(["--platform=android", "--store"]),
    ).resolves.toBeDefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Eliza mobile android store preflight"),
    );
    expect(process.exit).not.toHaveBeenCalled();
  });
});
