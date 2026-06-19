import { describe, expect, it } from "vitest";
import type { ElizaOsImage, RemovableDrive, WritePlan } from "../types";
import {
  assertDriveMatchesExpected,
  assertWritePlanAllowed,
  hasTrustedChecksum,
} from "../write-safety";

const trustedChecksum =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const drive: RemovableDrive = {
  id: "usb-1",
  name: "Test USB",
  devicePath: "/dev/sdb",
  sizeBytes: 16 * 1024 ** 3,
  bus: "usb",
  platform: "linux",
  safety: "safe-removable",
};

const image: ElizaOsImage = {
  id: "image-1",
  label: "elizaOS",
  version: "stable",
  channel: "stable",
  architecture: "x86_64",
  buildId: "stable-1",
  publishedAt: "2026-05-19T00:00:00.000Z",
  url: "https://download.elizaos.ai/elizaos.iso",
  checksumSha256: trustedChecksum,
  sizeBytes: 4 * 1024 ** 3,
  minUsbSizeBytes: 8 * 1024 ** 3,
  manifestVersion: 1,
};

function makePlan(overrides: Partial<WritePlan> = {}): WritePlan {
  return {
    request: {
      driveId: drive.id,
      imageId: image.id,
      dryRun: false,
      acknowledgeDataLoss: true,
    },
    drive,
    image,
    steps: [],
    privilegedWriteImplemented: true,
    ...overrides,
  };
}

describe("USB write safety", () => {
  it("rejects placeholder checksums for live writes", () => {
    expect(hasTrustedChecksum(trustedChecksum)).toBe(true);
    expect(hasTrustedChecksum("0".repeat(64))).toBe(false);
    expect(hasTrustedChecksum("1".repeat(64))).toBe(false);
    expect(hasTrustedChecksum("not-a-checksum")).toBe(false);

    expect(() =>
      assertWritePlanAllowed(
        makePlan({
          image: {
            ...image,
            checksumSha256: "0".repeat(64),
          },
        }),
      ),
    ).toThrow("trusted SHA-256");
  });

  it("rejects dry-run, unacknowledged, unsafe, and undersized plans", () => {
    expect(() =>
      assertWritePlanAllowed(
        makePlan({
          request: {
            driveId: drive.id,
            imageId: image.id,
            dryRun: true,
            acknowledgeDataLoss: true,
          },
        }),
      ),
    ).toThrow("Dry-run plans");

    expect(() =>
      assertWritePlanAllowed(
        makePlan({
          request: {
            driveId: drive.id,
            imageId: image.id,
            dryRun: false,
            acknowledgeDataLoss: false,
          },
        }),
      ),
    ).toThrow("acknowledgement");

    expect(() =>
      assertWritePlanAllowed(
        makePlan({
          drive: { ...drive, safety: "blocked-system" },
        }),
      ),
    ).toThrow("safe-removable");

    expect(() =>
      assertWritePlanAllowed(
        makePlan({
          drive: { ...drive, sizeBytes: 4 * 1024 ** 3 },
        }),
      ),
    ).toThrow("too small");
  });

  it("catches drive identity changes between plan and execute", () => {
    expect(() =>
      assertDriveMatchesExpected(
        {
          driveId: drive.id,
          imageId: image.id,
          dryRun: false,
          acknowledgeDataLoss: true,
          expectedDrive: {
            devicePath: "/dev/sdc",
            sizeBytes: drive.sizeBytes,
          },
        },
        drive,
      ),
    ).toThrow("changed before write");

    expect(() =>
      assertDriveMatchesExpected(
        {
          driveId: drive.id,
          imageId: image.id,
          dryRun: false,
          acknowledgeDataLoss: true,
          expectedDrive: {
            devicePath: drive.devicePath,
            sizeBytes: drive.sizeBytes + 1,
          },
        },
        drive,
      ),
    ).toThrow("size changed");
  });
});
