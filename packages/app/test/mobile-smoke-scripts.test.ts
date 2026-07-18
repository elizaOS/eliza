/**
 * Locks public mobile smoke commands and their CI evidence/gating contracts
 * without weakening the explicit local and remote compatibility lanes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appPackage = JSON.parse(
  readFileSync(path.resolve(testDir, "../package.json"), "utf8"),
) as { scripts: Record<string, string> };

const script = (name: string) => appPackage.scripts[name] ?? "";
const appleStoreWorkflow = readFileSync(
  path.resolve(testDir, "../../../.github/workflows/apple-store-release.yml"),
  "utf8",
);

describe("mobile simulator smoke package scripts", () => {
  it("makes public local-chat simulator lanes require a real installed app", () => {
    for (const name of [
      "test:sim:local-chat",
      "test:sim:local-chat:ios",
      "test:sim:local-chat:android",
      "test:sim:local-chat:both",
    ]) {
      expect(script(name), name).toContain("mobile-local-chat-smoke.mjs");
      expect(script(name), name).toContain("--require-installed");
    }
  });

  it("exposes the loud one-command iOS e2e orchestrator", () => {
    expect(script("test:e2e:ios")).toBe("node scripts/ios-e2e.mjs");
    expect(script("test:e2e:ios:cloud")).toBe(
      "node scripts/ios-e2e.mjs --cloud",
    );
  });

  it("ad-hoc signs the Cloud simulator app for real native Keychain auth", () => {
    const command = script("build:ios:cloud:sim");
    expect(command).toContain("ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0");
    expect(command).toContain("ELIZA_IOS_CODE_SIGNING_ALLOWED=YES");
    expect(command).toContain("ELIZA_IOS_BUILD_SDK=iphonesimulator");
  });

  it("pins Cloud onboarding to the lane's simulator and DerivedData product", () => {
    const command = script("test:e2e:ios:cloud-onboarding");
    const harness = readFileSync(
      path.resolve(testDir, "../scripts/ios-cloud-onboarding-smoke.mjs"),
      "utf8",
    );
    expect(command).toContain(
      `\${ELIZA_IOS_SIMULATOR_UDID:?Set ELIZA_IOS_SIMULATOR_UDID to the dedicated simulator UDID}`,
    );
    expect(command).toContain(
      'ELIZA_IOS_DERIVED_DATA_PATH="$PWD/ios/build/cloud-onboarding-derived-data"',
    );
    expect(command).toContain('--device "$ELIZA_IOS_SIMULATOR_UDID"');
    expect(command).toContain(
      '--app-path "$PWD/ios/build/cloud-onboarding-derived-data/Build/Products/Debug-iphonesimulator/App.app"',
    );
    expect(harness).toContain(
      "device.udid === target || device.name === target",
    );
    expect(harness).toContain(
      "requires an exact simulator via --device or ELIZA_IOS_SIMULATOR_UDID",
    );
    expect(harness).not.toContain("function bootedUdid");
  });

  it("keeps local and remote iOS compatibility behind explicit commands", () => {
    expect(script("build:ios")).toBe(
      "node ../../packages/app-core/scripts/run-mobile-build.mjs ios",
    );
    expect(script("build:ios:local")).toContain("ELIZA_IOS_FULL_BUN_ENGINE=1");
    const remote = script("build:ios:remote:sim");
    expect(remote).toContain(
      `\${VITE_ELIZA_IOS_API_BASE:?Set VITE_ELIZA_IOS_API_BASE to the explicit remote agent URL}`,
    );
    expect(remote).toContain("VITE_ELIZA_IOS_RUNTIME_MODE=remote-mac");
    expect(remote).toContain("ELIZA_BUILD_VARIANT=direct");
  });

  it("opens the already-generated iOS workspace without rebuilding it", () => {
    expect(script("cap:open:ios")).toBe("capacitor open ios");
  });

  it("ships the App Store workflow through the same Cloud-only policy", () => {
    expect(appleStoreWorkflow).toContain(
      'ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0"',
    );
    expect(appleStoreWorkflow).toContain('ELIZA_IOS_FULL_BUN_ENGINE: "0"');
    expect(appleStoreWorkflow).toContain("VITE_ELIZA_IOS_RUNTIME_MODE: cloud");
    expect(appleStoreWorkflow).toContain("VITE_ELIZA_RUNTIME_MODE: cloud");
    expect(appleStoreWorkflow).not.toContain(
      "VITE_ELIZA_IOS_RUNTIME_MODE: cloud-hybrid",
    );
    expect(appleStoreWorkflow).not.toContain("Build iOS agent bundle");
  });
});

describe("mobile-build-smoke.yml iOS chat-correctness gating (#13576)", () => {
  const workflow = readFileSync(
    path.resolve(testDir, "../../../.github/workflows/mobile-build-smoke.yml"),
    "utf8",
  );
  const iosE2e = readFileSync(
    path.resolve(testDir, "../scripts/ios-e2e.mjs"),
    "utf8",
  );
  const STEP_MARKER = "      - name:";

  // Return the YAML text of the single workflow step whose `- name:` line
  // contains the given fragment, up to (but excluding) the next step.
  const stepBlock = (nameFragment: string): string => {
    const at = workflow.indexOf(nameFragment);
    expect(at, `step named like "${nameFragment}" must exist`).toBeGreaterThan(
      -1,
    );
    const start = workflow.lastIndexOf(STEP_MARKER, at);
    expect(start, `step marker for "${nameFragment}"`).toBeGreaterThan(-1);
    const next = workflow.indexOf(`\n${STEP_MARKER}`, start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };

  // These lanes were promoted from continue-on-error (self-skip to success)
  // to hard-gating in #13576. Reintroducing continue-on-error here would let a
  // regression in iOS chat send/receive or the media-store/Filesystem/Share
  // path ship a green Mobile Build Smoke check — this test blocks that.
  for (const lane of [
    "Run iOS native attachment smoke",
    "Run iOS local-chat simulator smoke",
  ]) {
    it(`keeps the "${lane}" lane blocking (no continue-on-error)`, () => {
      expect(stepBlock(lane)).not.toContain("continue-on-error");
    });
  }

  it("still drives the promoted lanes through their real smoke scripts", () => {
    expect(stepBlock("Run iOS native attachment smoke")).toContain(
      "ios-attachment-smoke.mjs",
    );
    const localChat = stepBlock("Run iOS local-chat simulator smoke");
    expect(localChat).toContain("mobile-local-chat-smoke.mjs");
    expect(localChat).toContain("--platform ios --require-installed");
  });

  it("keeps the composed auth + full-Bun lane blocking and captures reviewable evidence", () => {
    const boot = stepBlock("Boot simulator and configure the full-Bun runtime");
    expect(boot).toContain("SIMCTL_CHILD_DYLD_FALLBACK_LIBRARY_PATH");
    expect(boot).toContain("System/Cryptexes/OS/usr/lib/swift");
    expect(boot).toContain("IOS_FULL_BUN_APP_PATH");

    const fullBun = stepBlock("Run composed iOS auth + full-Bun simulator e2e");
    expect(fullBun).not.toMatch(/\n\s*continue-on-error\s*:/);
    expect(fullBun).toContain("ios-e2e.mjs");
    expect(fullBun).toContain("--skip-build");
    expect(fullBun).toContain("--app-path");
    expect(fullBun).not.toContain("mobile-local-chat-smoke.mjs");
    expect(fullBun).toContain("recordVideo");
    expect(fullBun).toContain("ios-final.jpg");
    expect(fullBun).toContain("ios-simulator.log");
    expect(fullBun).toContain('process == "App"');
    expect(fullBun).toContain("test-results/auth/result.json");
    expect(fullBun).toContain("test-results/ios-full-bun/result.json");
    expect(fullBun).toContain("reports/ios-scheme-approval.json");
    expect(fullBun).toContain('callbackDisposition!=="deliver-to-app"');
    expect(fullBun).toContain('"plistPath" in r');
    expect(fullBun).toContain("orchestrator/summary.json");
    expect(iosE2e).toContain("ELIZA_IOS_FULL_BUN_SMOKE_EVIDENCE_DIR");
  });

  it("pins and proves the PR Simulator build is Cloud-only", () => {
    const build = stepBlock("Build Cloud-only iOS simulator app");
    expect(build).toContain('ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0"');
    expect(build).toContain('ELIZA_IOS_FULL_BUN_ENGINE: "0"');
    expect(build).toContain('VITE_ELIZA_IOS_RUNTIME_MODE: "cloud"');
    expect(build).toContain('VITE_ELIZA_RUNTIME_MODE: "cloud"');

    const verify = stepBlock("Verify staged renderer is the freshly built one");
    expect(verify).toContain('stamp.runtimeMode !== "cloud"');
    expect(verify).toContain("ElizaBunRuntime|MobileAgentBridge|LlamaCpp");
  });
});
