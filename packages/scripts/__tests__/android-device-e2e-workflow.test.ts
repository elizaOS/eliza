/** Guards the Android emulator workflow's single-process shell boundary and immutable action provenance. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const workflow = readFileSync(
  join(root, ".github/workflows/android-device-e2e.yml"),
  "utf8",
);
const androidHarness = readFileSync(
  join(root, "packages/app/test/android/android-harness.ts"),
  "utf8",
);
const onboardingSpec = readFileSync(
  join(root, "packages/app/test/android/onboarding-to-home.android.spec.ts"),
  "utf8",
);
const actionSha = "a421e43855164a8197daf9d8d40fe71c6996bb0d";
const setupNodeSha = "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const expectedCommands = [
  "bash scripts/mobile/android-emulator-webview-ci.sh full",
  "bash scripts/mobile/android-emulator-webview-ci.sh pr-smoke",
  "bash scripts/mobile/android-native-plugin-ci.sh",
];

function emulatorActionBlocks(): string[] {
  return workflow
    .split(/(?=^\s*- name:)/m)
    .filter((block) =>
      block.includes("reactivecircus/android-emulator-runner@"),
    );
}

describe("Android emulator workflow shell contract", () => {
  test("installs the required Node runtime without the unrelated artifact bundle", () => {
    expect(workflow).toContain('NODE_VERSION: "24.15.0"');
    expect(
      workflow.match(new RegExp(`actions/setup-node@${setupNodeSha}`, "g")),
    ).toHaveLength(3);
    expect(workflow.match(/bun run install:light/g)).toHaveLength(3);
    expect(workflow).not.toMatch(/^\s*run:\s*bun install\s*$/m);
  });

  test("reclaims hosted-runner disk without deleting the Android SDK", () => {
    expect(
      workflow.match(/if: runner\.environment == 'github-hosted'/g),
    ).toHaveLength(3);
    expect(workflow.match(/\/usr\/share\/dotnet/g)).toHaveLength(3);
    expect(workflow.match(/\/opt\/ghc/g)).toHaveLength(3);
    expect(workflow.match(/\/opt\/hostedtoolcache\/CodeQL/g)).toHaveLength(3);

    for (const block of workflow
      .split(/(?=^\s*- name:)/m)
      .filter((candidate) =>
        candidate.includes("Free disk for Android build"),
      )) {
      expect(block).not.toContain("/usr/local/lib/android");
    }
  });

  test("pins every emulator action and passes exactly one shell command", () => {
    const blocks = emulatorActionBlocks();
    expect(blocks).toHaveLength(expectedCommands.length);

    for (const [index, block] of blocks.entries()) {
      expect(block).toContain(
        `uses: reactivecircus/android-emulator-runner@${actionSha}`,
      );
      expect(block).toContain(`script: ${expectedCommands[index]}`);
      expect(block).not.toMatch(/script:\s*[|>]/);

      // android-emulator-runner v2 executes every nonblank line independently.
      const scriptValue = block.match(/^\s*script:\s*(.+)$/m)?.[1];
      expect(scriptValue?.split(/\r?\n/).filter(Boolean)).toEqual([
        expectedCommands[index],
      ]);
    }
  });

  test("keeps both committed Bash boundaries syntactically valid", () => {
    for (const relativePath of [
      "scripts/mobile/android-emulator-webview-ci.sh",
      "scripts/mobile/android-native-plugin-ci.sh",
    ]) {
      const result = spawnSync("bash", ["-n", join(root, relativePath)], {
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  test("rejects an unknown WebView lane before touching a device", () => {
    const result = spawnSync(
      "bash",
      [join(root, "scripts/mobile/android-emulator-webview-ci.sh"), "unknown"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage:");
  });

  test("keeps shell-reserved Android state out of live view-realm mutations", () => {
    const documentStart = androidHarness.indexOf("await page.addInitScript(");
    const seedWrite = androidHarness.indexOf(
      "localStorage.setItem(key, value)",
    );
    const livePageEvaluation = androidHarness.indexOf(
      "await page.evaluate(",
      documentStart,
    );

    expect(documentStart).toBeGreaterThan(-1);
    expect(seedWrite).toBeGreaterThan(documentStart);
    expect(seedWrite).toBeLessThan(livePageEvaluation);
    expect(
      androidHarness.match(/localStorage\.setItem\(key, value\)/g),
    ).toHaveLength(1);
    expect(onboardingSpec).not.toContain("localStorage.removeItem(");
    expect(onboardingSpec).toMatch(/page\.goto\(`\$\{ORIGIN\}\/\?reset`/);
  });
});
