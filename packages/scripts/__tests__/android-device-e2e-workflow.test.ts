/**
 * Ensures emulator-runner receives one Bash command per lane because the action
 * otherwise executes multiline input as independent `sh -c` processes.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../", import.meta.url);
const workflowPath = new URL(
  ".github/workflows/android-device-e2e.yml",
  repoRoot,
);
const appPackagePath = new URL("packages/app/package.json", repoRoot);
const onboardingSpecPath = new URL(
  "packages/app/test/android/onboarding-to-home.android.spec.ts",
  repoRoot,
);
const harnesses = [
  ".github/scripts/android-device-e2e/route-coverage.sh",
  ".github/scripts/android-device-e2e/pr-device-smoke.sh",
  ".github/scripts/android-device-e2e/native-plugin-android-test.sh",
] as const;

describe("Android emulator workflow shell boundary", () => {
  it("invokes every emulator lane as one committed Bash harness", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const actionReference =
      /uses: reactivecircus\/android-emulator-runner@([0-9a-f]{40})/g;
    const actionBlocks = workflow
      .split(actionReference)
      .filter((_, index) => index > 0 && index % 2 === 0);

    expect(actionBlocks).toHaveLength(harnesses.length);
    expect(
      actionBlocks.map((block) => block.match(/\n\s+script:\s+([^\n]+)/)?.[1]),
    ).toEqual(harnesses.map((path) => `bash ${path}`));
  });

  it.each(harnesses)("%s is valid strict Bash", (relativePath) => {
    const path = new URL(relativePath, repoRoot);
    const source = readFileSync(path, "utf8");

    expect(source).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(source).toContain("set -euo pipefail");
    const result = spawnSync("bash", ["-n", path.pathname], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("runs onboarding from canonical first-run reset state", () => {
    const appPackage = JSON.parse(readFileSync(appPackagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    const onboardingScript = appPackage.scripts["test:e2e:android:onboarding"];
    const onboardingSpec = readFileSync(onboardingSpecPath, "utf8");

    expect(onboardingScript).toContain("ELIZA_ANDROID_ALLOW_FIRST_RUN=1");
    expect(onboardingScript).toContain("ELIZA_ANDROID_CLEAR_APP_DATA=1");
    expect(onboardingSpec).toContain("?reset");
    expect(onboardingSpec).not.toMatch(
      /localStorage\.(?:setItem|removeItem)\(\s*["']eliza(?:os)?:/,
    );
  });
});
