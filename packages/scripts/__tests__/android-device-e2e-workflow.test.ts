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
const nativePluginCi = readFileSync(
  join(root, "scripts/mobile/android-native-plugin-ci.sh"),
  "utf8",
);
const assistantVerifier = readFileSync(
  join(root, "packages/app/scripts/android-assistant-verify.mjs"),
  "utf8",
);
const assistantVerifierLib = readFileSync(
  join(root, "packages/app/scripts/lib/android-assistant-verify-lib.mjs"),
  "utf8",
);
const androidCapture = readFileSync(
  join(root, "packages/app/scripts/lib/android-capture.mjs"),
  "utf8",
);
const imeProbeManifest = readFileSync(
  join(
    root,
    "packages/app-core/platforms/android/app/src/debug/AndroidManifest.xml",
  ),
  "utf8",
);
const imeProbeActivity = readFileSync(
  join(
    root,
    "packages/app-core/platforms/android/app/src/debug/java/ai/elizaos/app/ElizaImeProbeActivity.java",
  ),
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
    expect(onboardingSpec).toContain("await readCompletion()");
    expect(onboardingSpec).toMatch(
      /fetch\(`\$\{HOST_AGENT_BASE\}\/api\/config`/,
    );
    expect(onboardingSpec).toContain(
      "Host first-run completion was not observable",
    );
  });

  test("uses the supported role interface and explicit component receipts", () => {
    expect(nativePluginCi).toContain("cmd role get-role-holders");
    for (const source of [assistantVerifier, nativePluginCi])
      expect(source).not.toMatch(/cmd role holders/);
    expect(assistantVerifier).toContain('"get-role-holders"');
    expect(assistantVerifier).toContain('"--user"');
    expect(assistantVerifier).toContain('"query-services"');
    expect(assistantVerifier).toContain("ASSISTANT_SESSION_COMPONENT");
    expect(nativePluginCi).toContain("dumpsys-package.txt");
    expect(nativePluginCi).toContain("package-manager-components.txt");
  });

  test("raises the real IME and makes unknown ASR plus missing visual proof fail", () => {
    expect(imeProbeManifest).toContain(".ElizaImeProbeActivity");
    expect(imeProbeActivity).toContain("showSoftInput");
    expect(assistantVerifier).toContain("IME_PROBE_COMPONENT");
    expect(assistantVerifier).toContain("parseUiAutomatorBounds");
    expect(assistantVerifier).toContain(
      'if (process.argv.includes("--json")) console.error(line)',
    );
    expect(assistantVerifierLib).toContain(
      "IME ASR outcome was unknown after raising the real IME",
    );
    expect(nativePluginCi).toContain("assistant-verification.mp4");
    expect(nativePluginCi).toContain("assistant-final.png");
    expect(nativePluginCi).toContain("screenrecord.log");
    expect(nativePluginCi).toContain("KEYCODE_WAKEUP");
    expect(nativePluginCi.indexOf("KEYCODE_WAKEUP")).toBeLessThan(
      nativePluginCi.indexOf("adb shell screenrecord"),
    );
    expect(nativePluginCi).toContain("pidof screenrecord");
    expect(nativePluginCi).toContain('adb shell kill -2 "$SCREENRECORD_PID"');
    expect(nativePluginCi).not.toContain("pkill -INT screenrecord");
    expect(nativePluginCi).toContain("adb exec-out screencap -p");
    expect(nativePluginCi).toContain("frame-%06d.png");
    expect(nativePluginCi).toContain("resolveRequiredFfmpeg");
    expect(nativePluginCi).toContain('"$FFMPEG_BIN" -y -loglevel warning');
    expect(nativePluginCi).toContain("real-pixel fallback frames");
    expect(nativePluginCi).toContain("assertPlayableMp4");
    expect(androidCapture).toContain("waitForDeviceScreenRecordExit");
    expect(androidCapture).toContain('["ftyp", "mdat", "moov"]');
    expect(assistantVerifier).toContain(
      '["uiautomator", "dump", "--windows", hierarchyPath]',
    );
    expect(nativePluginCi).toContain(
      'JSON.parse(fs.readFileSync(process.argv[1], "utf8"))',
    );
    expect(workflow).toContain(
      "packages/app-core/platforms/android/app/build/reports/androidTests/**",
    );
    expect(workflow).toContain(
      "packages/app-core/platforms/android/app/build/outputs/androidTest-results/**",
    );
    expect(onboardingSpec).toContain("elizaMobileDeepLinkReady");
    expect(onboardingSpec).toContain("ensureHostFirstRunComplete");
    expect(onboardingSpec).toContain("/api/first-run/status");
    expect(onboardingSpec).toContain("/api/first-run");
    expect(assistantVerifier).toContain("voiceinteractionCommandSucceeded");
    expect(assistantVerifierLib).toContain(
      "cmd voiceinteraction show returned a failure",
    );
  });
});
