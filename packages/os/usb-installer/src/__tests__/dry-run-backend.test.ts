import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELIZAOS_IMAGES,
  DryRunUsbInstallerBackend,
  MOCK_REMOVABLE_DRIVES,
  validateImageManifest,
} from "../backend/dry-run-backend";
import type { ElizaOsImage, RemovableDrive } from "../backend/types";

const stableImage = DEFAULT_ELIZAOS_IMAGES[0] as ElizaOsImage;
const safeUsbDrive = MOCK_REMOVABLE_DRIVES[0] as RemovableDrive;

describe("DryRunUsbInstallerBackend", () => {
  it("lists image metadata and removable drive candidates", async () => {
    const backend = new DryRunUsbInstallerBackend();

    await expect(backend.listImages()).resolves.toEqual(DEFAULT_ELIZAOS_IMAGES);
    await expect(backend.listRemovableDrives()).resolves.toEqual(
      MOCK_REMOVABLE_DRIVES,
    );
    expect(stableImage).toMatchObject({
      channel: "stable",
      architecture: "x86_64",
      manifestVersion: 1,
    });
  });

  it("creates a dry-run write and verify plan for a safe removable drive", async () => {
    const backend = new DryRunUsbInstallerBackend();
    const plan = await backend.createWritePlan({
      driveId: "mock-usb-32gb",
      imageId: "elizaos-linux-live-stable",
      dryRun: true,
      acknowledgeDataLoss: true,
    });

    expect(plan.privilegedWriteImplemented).toBe(false);
    expect(plan.request.dryRun).toBe(true);
    expect(plan.steps.map((step) => step.status)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
  });

  it("rejects invalid image metadata before releases are exposed", () => {
    const invalidImage: ElizaOsImage = {
      ...stableImage,
      checksumSha256: "not-a-checksum",
      channel: "stable",
      minUsbSizeBytes: 1,
      url: "http://download.elizaos.ai/os/linux/elizaos-linux-live.iso",
    };

    expect(validateImageManifest([invalidImage])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "checksumSha256" }),
        expect.objectContaining({ field: "minUsbSizeBytes" }),
        expect.objectContaining({ field: "url" }),
      ]),
    );
    expect(
      () =>
        new DryRunUsbInstallerBackend(MOCK_REMOVABLE_DRIVES, [invalidImage]),
    ).toThrow("Invalid elizaOS image manifest");
  });

  it("rejects unknown drive and image ids", async () => {
    const backend = new DryRunUsbInstallerBackend();

    await expect(
      backend.createWritePlan({
        driveId: "missing-drive",
        imageId: "elizaos-linux-live-stable",
        dryRun: true,
        acknowledgeDataLoss: true,
      }),
    ).rejects.toThrow("Unknown drive id");

    await expect(
      backend.createWritePlan({
        driveId: "mock-usb-32gb",
        imageId: "missing-image",
        dryRun: true,
        acknowledgeDataLoss: true,
      }),
    ).rejects.toThrow("Unknown image id");
  });

  it("blocks system disks before any write step", async () => {
    const backend = new DryRunUsbInstallerBackend();
    const plan = await backend.createWritePlan({
      driveId: "mock-internal-system",
      imageId: "elizaos-linux-live-stable",
      dryRun: true,
      acknowledgeDataLoss: true,
    });

    expect(plan.steps.every((step) => step.status === "blocked")).toBe(true);
  });

  it("blocks a safe removable USB that is smaller than the image minimum", async () => {
    const tinyDrive: RemovableDrive = {
      ...safeUsbDrive,
      id: "mock-usb-4gb",
      sizeBytes: 4 * 1024 ** 3,
      safety: "safe-removable",
    };
    const backend = new DryRunUsbInstallerBackend([tinyDrive], [stableImage]);

    const plan = await backend.createWritePlan({
      driveId: "mock-usb-4gb",
      imageId: "elizaos-linux-live-stable",
      dryRun: true,
      acknowledgeDataLoss: true,
    });

    expect(plan.steps.every((step) => step.status === "blocked")).toBe(true);
    expect(plan.steps[0]?.detail).toContain("8 GiB is required");
  });

  it("blocks non-dry-run write requests because raw writes are not implemented", async () => {
    const backend = new DryRunUsbInstallerBackend();

    await expect(
      backend.createWritePlan({
        driveId: "mock-usb-32gb",
        imageId: "elizaos-linux-live-stable",
        dryRun: false,
        acknowledgeDataLoss: true,
      }),
    ).rejects.toThrow("Non-dry-run writes are blocked");
  });

  it("requires explicit data-loss acknowledgement", async () => {
    const backend = new DryRunUsbInstallerBackend();

    await expect(
      backend.createWritePlan({
        driveId: "mock-usb-32gb",
        imageId: "elizaos-linux-live-stable",
        dryRun: true,
        acknowledgeDataLoss: false,
      }),
    ).rejects.toThrow("Data-loss acknowledgement");
  });
});
