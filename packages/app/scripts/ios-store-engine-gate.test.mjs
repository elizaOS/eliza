/**
 * iOS store packaging policy and canonical build-command regressions.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveIosRuntimeConfig } from "../src/ios-runtime.ts";
import { evaluateIosStoreEngineGate } from "./ios-store-engine-gate.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
);

const runnerCommand =
  "node ../../packages/app-core/scripts/run-mobile-build.mjs ios";
const probeCommand =
  "node -e 'process.stdout.write(JSON.stringify({runtimeMode:process.env.VITE_ELIZA_IOS_RUNTIME_MODE??null,localRuntime:process.env.ELIZA_IOS_APP_STORE_LOCAL_RUNTIME??null,fullBun:process.env.ELIZA_IOS_FULL_BUN_ENGINE??null}))'";

function probeBuildScript(scriptName, overrides = {}) {
  const script = packageJson.scripts[scriptName];
  expect(script).toBeTypeOf("string");
  expect(script.endsWith(runnerCommand)).toBe(true);

  const env = { PATH: process.env.PATH, ...overrides };
  const result = spawnSync(
    "/bin/sh",
    ["-c", script.replace(runnerCommand, probeCommand)],
    {
      cwd: appRoot,
      encoding: "utf8",
      env,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
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
  it.each(["build:ios:cloud:sim", "build:ios:cloud:device"])(
    "%s bakes pure cloud mode without a local runtime payload",
    (scriptName) => {
      const resolved = probeBuildScript(scriptName);

      expect(resolved).toEqual({
        runtimeMode: "cloud",
        localRuntime: "0",
        fullBun: null,
      });
      expect(
        resolveIosRuntimeConfig({
          VITE_ELIZA_IOS_RUNTIME_MODE: resolved.runtimeMode,
        }),
      ).toMatchObject({ mode: "cloud", fullBun: false });
      expect(
        evaluateIosStoreEngineGate({
          ELIZA_BUILD_VARIANT: "store",
          ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: resolved.localRuntime,
          ELIZA_IOS_FULL_BUN_ENGINE: resolved.fullBun,
        }),
      ).toMatchObject({
        localRuntimeDisabled: true,
        engineWillEmbed: false,
      });
    },
  );

  it.each(["build:ios:cloud:sim", "build:ios:cloud:device"])(
    "%s preserves an explicit operator runtime-mode override",
    (scriptName) => {
      expect(
        probeBuildScript(scriptName, {
          VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
        }).runtimeMode,
      ).toBe("cloud-hybrid");
    },
  );

  it("leaves the App Store hybrid and local-runtime routes unchanged", () => {
    expect(packageJson.scripts["build:ios"]).toBe(runnerCommand);
    expect(packageJson.scripts["build:ios:chat-harness"]).toBe(
      "ELIZA_CHAT_UI_HARNESS=1 ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0 ELIZA_IOS_BUILD_DESTINATION='generic/platform=iOS Simulator' ELIZA_IOS_BUILD_SDK=iphonesimulator node ../../packages/app-core/scripts/run-mobile-build.mjs ios",
    );
    expect(packageJson.scripts["build:ios:local"]).toBe(
      "ELIZA_IOS_FULL_BUN_ENGINE=1 node ../../packages/app-core/scripts/run-mobile-build.mjs ios-local",
    );
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
