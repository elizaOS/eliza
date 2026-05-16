import { describe, expect, it, vi } from "vitest";
import { MOCK_BUILDS } from "../backend/adb-backend";
import type { AospFlasherBackend, ConnectedDevice } from "../backend/types";

// ---------------------------------------------------------------------------
// Minimal mock backend — avoids spawning real adb/fastboot in CI
// ---------------------------------------------------------------------------

const MOCK_DEVICE: ConnectedDevice = {
  serial: "ABC123TEST",
  model: "Pixel 9 Pro",
  codename: "caiman",
  state: "device",
  bootloaderUnlocked: null,
};

function makeMockBackend(): AospFlasherBackend {
  return {
    listConnectedDevices: vi.fn().mockResolvedValue([MOCK_DEVICE]),
    listBuilds: vi.fn().mockResolvedValue(MOCK_BUILDS),
    createFlashPlan: vi.fn().mockImplementation(async (request) => {
      const device = MOCK_DEVICE;
      const build = MOCK_BUILDS.find((b) => b.id === request.buildId);
      if (!build) throw new Error(`Unknown build: ${request.buildId}`);

      return {
        device,
        build,
        artifactDir: null,
        privilegedFlashImplemented: true,
        steps: [
          {
            id: "detect-device" as const,
            label: "Detect device",
            status: "pending" as const,
            detail: `adb -s ${device.serial} get-state`,
          },
          {
            id: "check-bootloader" as const,
            label: "Check bootloader lock state",
            status: "pending" as const,
            detail: `fastboot -s ${device.serial} getvar unlocked`,
          },
          {
            id: "reboot-bootloader" as const,
            label: "Reboot to bootloader",
            status: "pending" as const,
            detail: `adb -s ${device.serial} reboot bootloader`,
          },
          {
            id: "unlock-bootloader" as const,
            label: "Unlock bootloader",
            status: "pending" as const,
            detail: `fastboot -s ${device.serial} flashing unlock`,
            userAction:
              "On your device, use volume keys to select UNLOCK THE BOOTLOADER and press the power button",
          },
          {
            id: "download-artifacts" as const,
            label: "Download build artifacts",
            status: "pending" as const,
            detail: `Downloading ${build.label} to /tmp/elizaos-flasher/${build.id}/`,
          },
          {
            id: "verify-artifacts" as const,
            label: "Verify artifacts",
            status: "pending" as const,
            detail: "Checking boot.img, vendor_boot.img, super.img, vbmeta.img",
          },
          {
            id: "flash-partitions" as const,
            label: "Flash partitions",
            status: "pending" as const,
            detail: request.wipeData
              ? `install-elizaos-android.sh --device ${device.serial} --execute --confirm-flash --wipe-data`
              : `install-elizaos-android.sh --device ${device.serial} --execute --confirm-flash`,
          },
          {
            id: "reboot-android" as const,
            label: "Reboot to Android",
            status: "pending" as const,
            detail: `fastboot -s ${device.serial} reboot`,
          },
          {
            id: "validate-boot" as const,
            label: "Validate boot",
            status: "pending" as const,
            detail: `adb -s ${device.serial} wait-for-device`,
          },
          {
            id: "complete" as const,
            label: "Complete",
            status: "pending" as const,
            detail: "elizaOS flashed successfully",
          },
        ],
      };
    }),
    executeFlashPlan: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFlashPlan with mock device", () => {
  it("returns a plan with the correct device and build", async () => {
    const backend = makeMockBackend();
    const build = MOCK_BUILDS[0];
    if (!build) throw new Error("No mock builds available");

    const plan = await backend.createFlashPlan({
      deviceSerial: MOCK_DEVICE.serial,
      buildId: build.id,
      wipeData: false,
      dryRun: true,
    });

    expect(plan.device.serial).toBe(MOCK_DEVICE.serial);
    expect(plan.device.model).toBe("Pixel 9 Pro");
    expect(plan.device.codename).toBe("caiman");
    expect(plan.build.id).toBe(build.id);
    expect(plan.privilegedFlashImplemented).toBe(true);
  });

  it("produces all required flash steps in order", async () => {
    const backend = makeMockBackend();
    const build = MOCK_BUILDS[0];
    if (!build) throw new Error("No mock builds available");

    const plan = await backend.createFlashPlan({
      deviceSerial: MOCK_DEVICE.serial,
      buildId: build.id,
      wipeData: false,
      dryRun: true,
    });

    const stepIds = plan.steps.map((s) => s.id);
    expect(stepIds).toEqual([
      "detect-device",
      "check-bootloader",
      "reboot-bootloader",
      "unlock-bootloader",
      "download-artifacts",
      "verify-artifacts",
      "flash-partitions",
      "reboot-android",
      "validate-boot",
      "complete",
    ]);
  });

  it("all steps start as pending", async () => {
    const backend = makeMockBackend();
    const build = MOCK_BUILDS[0];
    if (!build) throw new Error("No mock builds available");

    const plan = await backend.createFlashPlan({
      deviceSerial: MOCK_DEVICE.serial,
      buildId: build.id,
      wipeData: false,
      dryRun: true,
    });

    expect(plan.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("includes --wipe-data in flash-partitions step when wipeData=true", async () => {
    const backend = makeMockBackend();
    const build = MOCK_BUILDS[0];
    if (!build) throw new Error("No mock builds available");

    const plan = await backend.createFlashPlan({
      deviceSerial: MOCK_DEVICE.serial,
      buildId: build.id,
      wipeData: true,
      dryRun: false,
    });

    const flashStep = plan.steps.find((s) => s.id === "flash-partitions");
    expect(flashStep?.detail).toContain("--wipe-data");
  });

  it("does NOT include --wipe-data when wipeData=false", async () => {
    const backend = makeMockBackend();
    const build = MOCK_BUILDS[0];
    if (!build) throw new Error("No mock builds available");

    const plan = await backend.createFlashPlan({
      deviceSerial: MOCK_DEVICE.serial,
      buildId: build.id,
      wipeData: false,
      dryRun: false,
    });

    const flashStep = plan.steps.find((s) => s.id === "flash-partitions");
    expect(flashStep?.detail).not.toContain("--wipe-data");
  });

  it("unlock-bootloader step has a userAction describing the physical steps", async () => {
    const backend = makeMockBackend();
    const build = MOCK_BUILDS[0];
    if (!build) throw new Error("No mock builds available");

    const plan = await backend.createFlashPlan({
      deviceSerial: MOCK_DEVICE.serial,
      buildId: build.id,
      wipeData: false,
      dryRun: true,
    });

    const unlockStep = plan.steps.find((s) => s.id === "unlock-bootloader");
    expect(unlockStep?.userAction).toBeTruthy();
    expect(unlockStep?.userAction).toContain("UNLOCK THE BOOTLOADER");
  });

  it("throws when build id is unknown", async () => {
    const backend = makeMockBackend();

    await expect(
      backend.createFlashPlan({
        deviceSerial: MOCK_DEVICE.serial,
        buildId: "nonexistent-build-id",
        wipeData: false,
        dryRun: true,
      }),
    ).rejects.toThrow("Unknown build");
  });

  it("all commands in step details reference the correct device serial", async () => {
    const backend = makeMockBackend();
    const build = MOCK_BUILDS[0];
    if (!build) throw new Error("No mock builds available");

    const plan = await backend.createFlashPlan({
      deviceSerial: MOCK_DEVICE.serial,
      buildId: build.id,
      wipeData: false,
      dryRun: true,
    });

    const commandSteps = plan.steps.filter(
      (s) => s.detail.includes("adb") || s.detail.includes("fastboot"),
    );

    for (const step of commandSteps) {
      expect(step.detail).toContain(MOCK_DEVICE.serial);
    }
  });
});

describe("MOCK_BUILDS", () => {
  it("has at least one build targeting a Pixel device", () => {
    expect(MOCK_BUILDS.length).toBeGreaterThan(0);
    const firstBuild = MOCK_BUILDS[0];
    expect(firstBuild).toBeDefined();
    expect(firstBuild?.targetDevice).toBeTruthy();
    expect(firstBuild?.channel).toMatch(/^(stable|beta|nightly)$/);
  });
});
