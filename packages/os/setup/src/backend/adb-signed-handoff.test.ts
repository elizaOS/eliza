// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AdbFlasherBackend } from "./adb-backend";
import { executeSignedInstall } from "./signed-install";
import type { FlashPlan } from "./types";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((command, args) => ({
    status: 0,
    stderr: "",
    stdout:
      command === "node" ? "{}" : args.includes("getprop") ? "0\n" : "device\n",
  })),
}));
vi.mock("../dependencies/host-tools", () => ({
  findHostTool: (name: string) => `/fixture/tools/${name}`,
}));
vi.mock("./signed-install", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signed-install")>()),
  executeSignedInstall: vi.fn(async () => "/fixture/journal.jsonl"),
}));
vi.mock("./signed-release", () => ({
  signedInstallerPath: () => "/fixture/install-release.mjs",
  describeSignedRelease: vi.fn(async () => ({
    subjectSha256: "a".repeat(64),
    release: {},
  })),
  signedReleaseFiles: () => [
    { filename: "boot.img", sha256: "b".repeat(64), sizeBytes: 7 },
  ],
}));
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<FlashPlan> {
  const root = await mkdtemp(join(tmpdir(), "elizaos-desktop-handoff-"));
  directories.push(root);
  const bytes = '{"schemaVersion":2,"fixture":true}\n';
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, bytes);
  await writeFile(join(root, "boot.img"), "fixture");
  return {
    device: {
      serial: "fixture",
      model: "fixture",
      codename: "grizzly",
      state: "device",
      bootloaderUnlocked: true,
    },
    build: {
      id: "signed",
      label: "signed",
      version: "1",
      channel: "beta",
      targetDevice: "grizzly",
      targetId: "pixel11pro-grizzly",
      architecture: "arm64-v8a",
      publishedAt: "2026-09-25T00:00:00Z",
      manifestUrl: "",
      manifestPath,
      signedManifest: bytes,
      sizeBytes: 7,
      wipeData: false,
    },
    artifactDir: root,
    steps: [
      { id: "detect-device", label: "Detect", detail: "", status: "pending" },
    ],
    request: {
      deviceSerial: "fixture",
      buildId: "signed",
      wipeData: true,
      dryRun: false,
    },
  };
}

test("desktop delegates once from Android and uses the reviewed wipe choice", async () => {
  const plan = await fixture();
  const progress = vi.fn();
  await new AdbFlasherBackend({
    healthTokenFile: "/fixture/token",
    stateDirectory: "/fixture/state",
  }).executeFlashPlan(plan, progress);
  expect(executeSignedInstall).toHaveBeenCalledExactlyOnceWith({
    artifactDir: plan.artifactDir,
    manifestPath: plan.build.manifestPath,
    subjectSha256: "a".repeat(64),
    serial: "fixture",
    toolDir: "/fixture/tools",
    healthTokenFile: "/fixture/token",
    stateDirectory: "/fixture/state",
    wipe: true,
  });
  expect(
    vi
      .mocked(spawnSync)
      .mock.calls.filter(([command]) => command !== "node")
      .map(([, args]) => args),
  ).toEqual([
    ["-s", "fixture", "get-state"],
    ["-s", "fixture", "shell", "getprop", "ro.boot.flash.locked"],
  ]);
  expect(progress.mock.calls).toContainEqual([
    "complete",
    "complete",
    "elizaOS installed and runtime verified",
  ]);
});

test("executor failure propagates without a desktop reboot or success event", async () => {
  const plan = await fixture();
  vi.mocked(executeSignedInstall).mockRejectedValueOnce(
    new Error("fixture disk failure"),
  );
  const progress = vi.fn();
  await expect(
    new AdbFlasherBackend({
      healthTokenFile: "/fixture/token",
    }).executeFlashPlan(plan, progress),
  ).rejects.toThrow("fixture disk failure");
  expect(
    progress.mock.calls.some(
      ([step, status]) => step === "complete" && status === "complete",
    ),
  ).toBe(false);
  expect(
    vi
      .mocked(spawnSync)
      .mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("reboot"),
      ),
  ).toBe(false);
});

test("requests to stop inside the canonical installation are rejected before device access", async () => {
  const plan = await fixture();
  for (const step of [
    "flash-partitions",
    "reboot-android",
    "validate-boot",
  ] as const) {
    plan.request.stopAfter = step;
    await expect(
      new AdbFlasherBackend().executeFlashPlan(plan, vi.fn()),
    ).rejects.toThrow("cannot pause");
  }
  expect(spawnSync).not.toHaveBeenCalled();
  expect(executeSignedInstall).not.toHaveBeenCalled();
});
