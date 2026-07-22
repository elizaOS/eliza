/** Exercises iOS build policy both directly and through a fresh real runner process. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isIosAppStoreBuild,
  resolveIosDeploymentTarget,
  resolveMobileBuildPolicy,
  shouldIncludeIosFullBunEngine,
} from "./run-mobile-build.mjs";

const runnerUrl = new URL("./run-mobile-build.mjs", import.meta.url).href;
const IOS_POLICY_ENV_KEYS = [
  "ELIZA_BUILD_VARIANT",
  "ELIZA_RELEASE_AUTHORITY",
  "ELIZA_IOS_RUNTIME_MODE",
  "VITE_ELIZA_IOS_RUNTIME_MODE",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "VITE_ELIZA_RUNTIME_MODE",
  "ELIZA_IOS_APP_STORE_LOCAL_RUNTIME",
  "ELIZA_IOS_FULL_BUN_ENGINE",
];

function readIosPolicyFromFreshProcess(overrides = {}) {
  const env = { ...process.env };
  for (const key of IOS_POLICY_ENV_KEYS) delete env[key];
  Object.assign(env, overrides);
  const resultDirectory = mkdtempSync(join(tmpdir(), "eliza-ios-policy-"));
  const resultPath = join(resultDirectory, "result.json");
  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { writeFileSync } from "node:fs";
          import {
            configureIosAppStoreBuildDefaults,
            isIosAppStoreBuild,
            resolveIosDeploymentTarget,
            resolveMobileBuildPolicy,
            shouldIncludeIosFullBunEngine,
          } from ${JSON.stringify(runnerUrl)};
          configureIosAppStoreBuildDefaults();
          writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
            appStoreBuild: isIosAppStoreBuild(),
            deploymentTarget: resolveIosDeploymentTarget(),
            includeFullBunEngine: shouldIncludeIosFullBunEngine(),
            localRuntime: process.env.ELIZA_IOS_APP_STORE_LOCAL_RUNTIME,
            policy: resolveMobileBuildPolicy("ios"),
            runtimeMode: process.env.VITE_ELIZA_IOS_RUNTIME_MODE,
          }));
        `,
      ],
      { env },
    );
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } finally {
    rmSync(resultDirectory, { force: true, recursive: true });
  }
}

// Launch builds intentionally omit the local runtime. The gate still guarantees
// that an explicitly local-enabled custom store build embeds the engine instead
// of advertising a runtime that the IPA cannot start.

describe("iOS full-Bun engine embed gate", () => {
  it("does not embed the engine without an explicit local-runtime request", () => {
    expect(isIosAppStoreBuild({})).toBe(false);
    expect(shouldIncludeIosFullBunEngine({})).toBe(false);
  });

  it("a plain direct build does not embed the engine", () => {
    const env = { ELIZA_BUILD_VARIANT: "direct" };
    expect(isIosAppStoreBuild(env)).toBe(false);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("ELIZA_BUILD_VARIANT=store is Cloud-only by default", () => {
    const env = { ELIZA_BUILD_VARIANT: "store" };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("ELIZA_BUILD_VARIANT=store is case-insensitive", () => {
    expect(
      shouldIncludeIosFullBunEngine({ ELIZA_BUILD_VARIANT: "STORE" }),
    ).toBe(false);
  });

  it("ELIZA_RELEASE_AUTHORITY=apple-app-store remains Cloud-only by default", () => {
    const env = { ELIZA_RELEASE_AUTHORITY: "apple-app-store" };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("explicit ELIZA_IOS_FULL_BUN_ENGINE=1 embeds the engine even on a direct build", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
    };
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("a store build can opt into the local runtime", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
    };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("cloud-only opt-out is overridden by an explicit engine request", () => {
    // ELIZA_IOS_FULL_BUN_ENGINE is the unconditional force switch.
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
    };
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("the production release env remains Cloud-only", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_RELEASE_AUTHORITY: "apple-app-store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      ELIZA_IOS_FULL_BUN_ENGINE: "0",
    };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });
});

describe("iOS renderer build policy", () => {
  it("makes the tracked iOS lane Cloud-only", () => {
    expect(resolveMobileBuildPolicy("ios")).toMatchObject({
      buildVariant: "store",
      capacitorTarget: "ios",
      iosRuntimeMode: "cloud",
      runtimeExecutionMode: "cloud",
      releaseAuthority: "apple-app-store",
    });
  });

  it("retains local execution as an explicit lane", () => {
    expect(resolveMobileBuildPolicy("ios-local")).toMatchObject({
      buildVariant: "direct",
      capacitorTarget: "ios",
      iosRuntimeMode: "local",
      runtimeExecutionMode: "local-safe",
      releaseAuthority: "developer-toolchain",
    });
  });
});

describe("iOS deployment target", () => {
  it("keeps Cloud launch and explicit local builds on the HTTPS callback floor", () => {
    expect(resolveIosDeploymentTarget({})).toBe("17.4");
    expect(resolveIosDeploymentTarget({ ELIZA_IOS_FULL_BUN_ENGINE: "1" })).toBe(
      "17.4",
    );
  });
});

describe("fresh-process iOS release contract", () => {
  it("executes the real build runner with Cloud-only launch defaults", () => {
    expect(readIosPolicyFromFreshProcess()).toEqual({
      appStoreBuild: true,
      deploymentTarget: "17.4",
      includeFullBunEngine: false,
      localRuntime: "0",
      policy: {
        androidRuntimeMode: null,
        appControlledOta: false,
        buildVariant: "store",
        capacitorTarget: "ios",
        iosRuntimeMode: "cloud",
        releaseAuthority: "apple-app-store",
        runtimeExecutionMode: "cloud",
      },
      runtimeMode: "cloud",
    });
  });

  it("preserves an explicit custom local-runtime opt-in", () => {
    expect(
      readIosPolicyFromFreshProcess({
        ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
      }),
    ).toMatchObject({
      appStoreBuild: true,
      deploymentTarget: "17.4",
      includeFullBunEngine: true,
      localRuntime: "1",
    });
  });
});
