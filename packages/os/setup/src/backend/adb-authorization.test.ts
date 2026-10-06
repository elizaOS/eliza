// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AdbFlasherBackend } from "./adb-backend";
import * as signedRelease from "./signed-release";
import type { FlashPlan } from "./types";

vi.mock("./host-tools", () => ({
  findHostTool: () => undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: vi.fn((command, args, options) => {
      if (command === "node") return original.spawnSync(command, args, options);
      const stdout =
        command === "fastboot"
          ? "fixture fastboot\n"
          : args.includes("getprop")
            ? "1\n"
            : "device\n";
      return { status: 0, stdout, stderr: "" };
    }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<FlashPlan> {
  const directory = await mkdtemp(
    join(tmpdir(), "elizaos-setup-authorization-"),
  );
  directories.push(directory);
  const manifest = { schemaVersion: 1 };
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(directory, "boot.img"), "fixture");
  return {
    device: {
      serial: "fixture",
      model: "fixture",
      codename: "grizzly",
      state: "device",
      bootloaderUnlocked: false,
    },
    build: {
      id: "fixture",
      label: "fixture",
      version: "fixture",
      channel: "beta",
      targetDevice: "grizzly",
      targetId: "pixel11pro-grizzly",
      architecture: "arm64-v8a",
      publishedAt: "2026-09-25T00:00:00Z",
      manifestUrl: "",
      manifestPath,
      signedManifest: JSON.stringify(manifest),
      sizeBytes: 7,
    },
    steps: [
      {
        id: "detect-device",
        label: "Detect",
        status: "pending",
        detail: "fixture",
      },
    ],
    artifactDir: directory,
    request: {
      deviceSerial: "fixture",
      buildId: "fixture",
      wipeData: true,
      dryRun: false,
    },
  };
}

function authenticateFixture() {
  vi.spyOn(signedRelease, "describeSignedRelease").mockResolvedValue({
    subjectSha256: "a".repeat(64),
    issuedAt: "2026-09-25T00:00:00Z",
    release: {
      releaseId: "fixture",
      version: "1",
      channel: "beta",
      operation: "os-install",
      target: {
        id: "pixel11pro-grizzly",
        codename: "grizzly",
        kind: "physical",
        architecture: "arm64",
      },
      files: [{ filename: "boot.img", sha256: "a".repeat(64), sizeBytes: 7 }],
      startingStates: [],
    },
  });
}

function deviceEffects() {
  return vi
    .mocked(spawnSync)
    .mock.calls.filter(
      ([command, args]) =>
        command !== "node" &&
        Array.isArray(args) &&
        args.some((arg) =>
          ["reboot", "flashing", "flash", "erase", "-w"].includes(arg),
        ),
    );
}

test("real signed validator rejects legacy artifacts before any reboot or unlock", async () => {
  const plan = await fixture();
  const progress = vi.fn();
  await expect(
    new AdbFlasherBackend().executeFlashPlan(plan, progress),
  ).rejects.toThrow("installation requires a signed schemaVersion 2 contract");
  expect(
    vi
      .mocked(spawnSync)
      .mock.calls.some(
        ([command, args]) =>
          command === "node" &&
          Array.isArray(args) &&
          args.includes("--describe"),
      ),
  ).toBe(true);
  expect(deviceEffects()).toEqual([]);
});

test("missing local artifacts fail before any reboot or unlock", async () => {
  authenticateFixture();
  const plan = await fixture();
  await rm(join(plan.artifactDir as string, "boot.img"));
  await expect(
    new AdbFlasherBackend().executeFlashPlan(plan, vi.fn()),
  ).rejects.toThrow("Missing artifact files");
  expect(deviceEffects()).toEqual([]);
});

test("download-only plans authenticate before stopping without device effects", async () => {
  authenticateFixture();
  const plan = await fixture();
  plan.request.stopAfter = "download-artifacts";
  const progress = vi.fn();
  await new AdbFlasherBackend().executeFlashPlan(plan, progress);
  expect(deviceEffects()).toEqual([]);
  expect(
    progress.mock.calls.some(([step]) => step === "verify-artifacts"),
  ).toBe(false);
  expect(
    vi.mocked(spawnSync).mock.calls.some(([command]) => command === "node"),
  ).toBe(false);
});

test("explicit standalone bootloader guide does not require installation artifacts", async () => {
  const plan = await fixture();
  plan.request.stopAfter = "reboot-bootloader";
  await rm(plan.build.manifestPath as string);
  vi.useFakeTimers();
  const execution = new AdbFlasherBackend().executeFlashPlan(plan, vi.fn());
  await vi.advanceTimersByTimeAsync(2_000);
  await execution;
  expect(deviceEffects()).toHaveLength(1);
  expect(deviceEffects()[0]?.[1]).toEqual([
    "-s",
    "fixture",
    "reboot",
    "bootloader",
  ]);
  expect(
    vi.mocked(spawnSync).mock.calls.some(([command]) => command === "node"),
  ).toBe(false);
});

test("standalone unlock resumes in fastboot and verifies completion without ADB", async () => {
  const plan = await fixture();
  plan.device.state = "bootloader";
  plan.request.stopAfter = "unlock-bootloader";
  const result = (stdout: string, stderr = "") => ({
    status: 0,
    stdout,
    stderr,
  });
  vi.mocked(spawnSync)
    .mockReturnValueOnce(
      result("fixture fastboot\n") as ReturnType<typeof spawnSync>,
    )
    .mockReturnValueOnce(
      result("", "(bootloader) product: grizzly\n") as ReturnType<
        typeof spawnSync
      >,
    )
    .mockReturnValueOnce(
      result("", "unlocked: no\n") as ReturnType<typeof spawnSync>,
    )
    .mockReturnValueOnce(result("") as ReturnType<typeof spawnSync>)
    .mockReturnValueOnce(
      result("", "unlocked: yes\n") as ReturnType<typeof spawnSync>,
    );
  vi.useFakeTimers();
  const progress = vi.fn();
  const execution = new AdbFlasherBackend().executeFlashPlan(plan, progress);
  await vi.advanceTimersByTimeAsync(5_000);
  await execution;
  expect(
    vi
      .mocked(spawnSync)
      .mock.calls.every(([command]) => command === "fastboot"),
  ).toBe(true);
  expect(progress.mock.calls).toContainEqual([
    "unlock-bootloader",
    "complete",
    "Bootloader unlocked",
  ]);
});

test("a serial substring cannot authorize unlocking a different device", async () => {
  const plan = await fixture();
  plan.device.state = "bootloader";
  plan.request.stopAfter = "unlock-bootloader";
  vi.mocked(spawnSync).mockReturnValueOnce({
    status: 0,
    stdout: "fixture-other fastboot\n",
    stderr: "",
  } as ReturnType<typeof spawnSync>);
  await expect(
    new AdbFlasherBackend().executeFlashPlan(plan, vi.fn()),
  ).rejects.toThrow("no longer connected");
  expect(deviceEffects()).toEqual([]);
});

test("device discovery includes fastboot-only devices", async () => {
  const result = (stdout: string, stderr = "") =>
    ({ status: 0, stdout, stderr }) as ReturnType<typeof spawnSync>;
  vi.mocked(spawnSync)
    .mockReturnValueOnce(result("List of devices attached\n"))
    .mockReturnValueOnce(result("fixture fastboot\n"))
    .mockReturnValueOnce(result("", "product: grizzly\n"))
    .mockReturnValueOnce(result("", "unlocked: no\n"));
  expect(await new AdbFlasherBackend().listConnectedDevices()).toEqual([
    {
      serial: "fixture",
      state: "bootloader",
      model: "Unknown",
      codename: "grizzly",
      bootloaderUnlocked: false,
    },
  ]);
});
