/**
 * iOS store packaging policy and canonical build-command regressions.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveIosBuildEnvironment,
  resolveIosBuildTargetPolicy,
} from "../../app-core/scripts/mobile/targets/ios.mjs";
import { resolveIosRuntimeConfig } from "../src/ios-runtime.ts";
import { evaluateIosStoreEngineGate } from "./ios-store-engine-gate.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
);

function loadCapacitorConfigWithEnv(environment) {
  const probe = [
    'import config from "./capacitor.config.ts";',
    "process.stdout.write(JSON.stringify(config));",
  ].join("\n");
  return JSON.parse(
    execFileSync(process.execPath, ["--eval", probe], {
      cwd: appRoot,
      env: environment,
      encoding: "utf8",
    }),
  );
}

/** Build an env with the iOS engine-gate vars unset, then apply overrides. */
const env = (overrides = {}) => ({
  ELIZA_BUILD_VARIANT: undefined,
  ELIZA_RELEASE_AUTHORITY: undefined,
  ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: undefined,
  ELIZA_IOS_FULL_BUN_ENGINE: undefined,
  ...overrides,
});

describe("evaluateIosStoreEngineGate (#8861)", () => {
  it("a store build with the local runtime left enabled EMBEDS the engine (the regression guard)", () => {
    // This is the exact case the bug shipped wrong: store IPA without the
    // engine → "start local agent" hard-fails. It MUST embed.
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "store" }))
        .engineWillEmbed,
    ).toBe(true);
    expect(
      evaluateIosStoreEngineGate(
        env({ ELIZA_RELEASE_AUTHORITY: "apple-app-store" }),
      ).engineWillEmbed,
    ).toBe(true);
  });

  it("detects the store variant from either flag (case-insensitive)", () => {
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "STORE" }))
        .storeVariant,
    ).toBe(true);
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "direct" }))
        .storeVariant,
    ).toBe(false);
    expect(evaluateIosStoreEngineGate(env()).storeVariant).toBe(false);
  });

  it("defaults the local runtime ON (must be explicitly disabled)", () => {
    expect(evaluateIosStoreEngineGate(env()).localRuntimeDisabled).toBe(false);
    for (const v of ["0", "false", "no", "off", "OFF", " 0 "]) {
      expect(
        evaluateIosStoreEngineGate(
          env({ ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: v }),
        ).localRuntimeDisabled,
      ).toBe(true);
    }
    for (const v of ["1", "true", "yes", "anything"]) {
      expect(
        evaluateIosStoreEngineGate(
          env({ ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: v }),
        ).localRuntimeDisabled,
      ).toBe(false);
    }
  });

  it("an intentional cloud-only store build (local runtime disabled) omits the engine", () => {
    const gate = evaluateIosStoreEngineGate(
      env({
        ELIZA_BUILD_VARIANT: "store",
        ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      }),
    );
    expect(gate.storeVariant).toBe(true);
    expect(gate.localRuntimeDisabled).toBe(true);
    expect(gate.engineWillEmbed).toBe(false);
  });

  it("ELIZA_IOS_FULL_BUN_ENGINE forces the engine even off a store build, and beats a disabled local runtime", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      expect(
        evaluateIosStoreEngineGate(env({ ELIZA_IOS_FULL_BUN_ENGINE: v }))
          .engineWillEmbed,
      ).toBe(true);
    }
    // forced wins over an explicit cloud-only disable.
    expect(
      evaluateIosStoreEngineGate(
        env({
          ELIZA_BUILD_VARIANT: "store",
          ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
          ELIZA_IOS_FULL_BUN_ENGINE: "1",
        }),
      ).engineWillEmbed,
    ).toBe(true);
  });

  it("a non-store build without forcing does NOT embed the engine", () => {
    expect(evaluateIosStoreEngineGate(env()).engineWillEmbed).toBe(false);
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "direct" }))
        .engineWillEmbed,
    ).toBe(false);
  });
});

describe("canonical iOS runtime build scripts", () => {
  it("routes both named Cloud commands through the strict ios-cloud target", () => {
    expect(packageJson.scripts["build:ios:cloud:sim"]).toBe(
      "ELIZA_IOS_BUILD_DESTINATION='generic/platform=iOS Simulator' ELIZA_IOS_BUILD_SDK=iphonesimulator node ../../packages/app-core/scripts/run-mobile-build.mjs ios-cloud",
    );
    expect(packageJson.scripts["build:ios:cloud:device"]).toBe(
      "ELIZA_IOS_CODE_SIGNING_ALLOWED=YES ELIZA_IOS_ALLOW_PROVISIONING_UPDATES=1 ELIZA_IOS_BUILD_DESTINATION='generic/platform=iOS' ELIZA_IOS_BUILD_SDK=iphoneos node ../../packages/app-core/scripts/run-mobile-build.mjs ios-cloud",
    );
    expect(resolveIosBuildTargetPolicy("ios-cloud")).toMatchObject({
      iosRuntimeMode: "cloud",
      runtimeExecutionMode: "cloud",
      environmentAuthority: "target",
      localEngine: "forbidden",
    });
  });

  it("forces inherited release and local-engine flags to the pure-cloud target", () => {
    const resolved = resolveIosBuildEnvironment("ios-cloud", {
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
      ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE: "1",
      VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
      VITE_ELIZA_IOS_FULL_BUN_STRICT: "1",
      VITE_ELIZA_IOS_FULL_BUN_SMOKE: "1",
    });

    expect(resolved).toMatchObject({
      ELIZA_CAPACITOR_BUILD_TARGET: "ios",
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_RELEASE_AUTHORITY: "apple-app-store",
      ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE: "0",
      ELIZA_IOS_SKIP_CAPACITOR_SYNC: "0",
      ELIZA_IOS_SKIP_POD_INSTALL: "0",
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
      ELIZA_IOS_RUNTIME_MODE: "cloud",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      ELIZA_IOS_FULL_BUN_ENGINE: "0",
      ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE: "0",
      VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "0",
      VITE_ELIZA_IOS_FULL_BUN_STRICT: "0",
      VITE_ELIZA_IOS_FULL_BUN_SMOKE: "0",
      ELIZA_RUNTIME_MODE: "cloud",
      ELIZA_IOS_INCLUDE_LLAMA: "0",
    });
    expect(resolveIosRuntimeConfig(resolved)).toMatchObject({
      mode: "cloud",
      fullBun: false,
    });
    expect(evaluateIosStoreEngineGate(resolved)).toMatchObject({
      localRuntimeDisabled: true,
      engineForced: false,
      engineWillEmbed: false,
    });
  });

  it("loads the actual Capacitor config as an iOS cloud store build despite polluted shell env", () => {
    const resolved = resolveIosBuildEnvironment("ios-cloud", {
      ...process.env,
      ELIZA_CAPACITOR_BUILD_TARGET: "android",
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
      ELIZA_WEBVIEW_DEBUG: "1",
      ELIZA_CAPACITOR_SERVER_URL: "http://127.0.0.1:5173",
      VITE_ELIZA_IOS_API_BASE: "http://127.0.0.1:31337",
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
      VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
    });
    const config = loadCapacitorConfigWithEnv(resolved);

    expect(config.server.url).toBeUndefined();
    expect(config.server.allowNavigation).not.toContain("localhost");
    expect(config.server.allowNavigation).not.toContain("127.0.0.1");
    expect(config.plugins.Agent).toMatchObject({
      runtimeMode: "cloud",
      fullBunAvailable: "0",
      apiBase: "",
    });
    expect(config.ios.webContentsDebuggingEnabled).toBe(false);
  });

  it("rejects a hybrid runtime override on the pure-cloud target", () => {
    expect(() =>
      resolveIosBuildEnvironment("ios-cloud", {
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
      }),
    ).toThrow(
      "ios-cloud requires VITE_ELIZA_IOS_RUNTIME_MODE=cloud; received cloud-hybrid",
    );
  });

  it("leaves the App Store hybrid and local-runtime routes unchanged", () => {
    expect(packageJson.scripts["build:ios"]).toBe(
      "node ../../packages/app-core/scripts/run-mobile-build.mjs ios",
    );
    expect(packageJson.scripts["build:ios:chat-harness"]).toBe(
      "ELIZA_CHAT_UI_HARNESS=1 ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0 ELIZA_IOS_BUILD_DESTINATION='generic/platform=iOS Simulator' ELIZA_IOS_BUILD_SDK=iphonesimulator node ../../packages/app-core/scripts/run-mobile-build.mjs ios",
    );
    expect(packageJson.scripts["build:ios:local"]).toBe(
      "ELIZA_IOS_FULL_BUN_ENGINE=1 node ../../packages/app-core/scripts/run-mobile-build.mjs ios-local",
    );
    expect(
      resolveIosBuildEnvironment("ios", {
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
      }),
    ).toMatchObject({
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_RELEASE_AUTHORITY: "apple-app-store",
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
    });
    expect(
      resolveIosBuildEnvironment("ios", {
        ELIZA_BUILD_VARIANT: "direct",
        ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
      }),
    ).toMatchObject({
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
    });
    expect(
      resolveIosBuildEnvironment("ios-local", {
        VITE_ELIZA_IOS_RUNTIME_MODE: "local",
        ELIZA_IOS_FULL_BUN_ENGINE: "1",
      }),
    ).toMatchObject({
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
      VITE_ELIZA_IOS_RUNTIME_MODE: "local",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
    });
    expect(packageJson.scripts["build:ios:local:sim"]).toContain(
      "ELIZA_IOS_FULL_BUN_ENGINE=1",
    );
    expect(packageJson.scripts["build:ios:local:sim"]).toContain(
      "run-mobile-build.mjs ios-local",
    );
    expect(packageJson.scripts["build:ios:local:device"]).toContain(
      "ELIZA_IOS_FULL_BUN_ENGINE=1",
    );
    expect(packageJson.scripts["build:ios:local:device"]).toContain(
      "run-mobile-build.mjs ios-local",
    );
  });
});
