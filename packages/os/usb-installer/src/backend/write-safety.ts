// Implements platform-specific USB installer backend safety behavior.
import type { RemovableDrive, WritePlan, WriteRequest } from "./types";

const placeholderChecksumPattern = /^([a-f0-9])\1{63}$/;

export function hasTrustedChecksum(checksumSha256: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(checksumSha256) &&
    !placeholderChecksumPattern.test(checksumSha256)
  );
}

export function assertDriveMatchesExpected(
  request: WriteRequest,
  drive: RemovableDrive,
): void {
  const expected = request.expectedDrive;
  if (!expected) {
    return;
  }

  if (drive.devicePath !== expected.devicePath) {
    throw new Error(
      `Selected drive changed before write: expected ${expected.devicePath}, found ${drive.devicePath}. Refresh drives and reselect the target.`,
    );
  }

  if (drive.sizeBytes !== expected.sizeBytes) {
    throw new Error(
      `Selected drive size changed before write: expected ${expected.sizeBytes} bytes, found ${drive.sizeBytes} bytes. Refresh drives and reselect the target.`,
    );
  }

  if (expected.stableId && drive.stableId !== expected.stableId) {
    throw new Error(
      "Selected drive hardware identity changed before write. Refresh drives and reselect the target.",
    );
  }
}

export interface WritePlanSafetyOptions {
  canonicalRawZstdSupported?: boolean;
}

export function assertWritePlanAllowed(
  plan: WritePlan,
  options: WritePlanSafetyOptions = {},
): void {
  if (!plan.request.acknowledgeDataLoss) {
    throw new Error("Data-loss acknowledgement is required.");
  }

  if (plan.request.dryRun) {
    throw new Error("Dry-run plans cannot be executed.");
  }

  if (plan.drive.safety !== "safe-removable") {
    throw new Error("Drive is not safe-removable; write aborted.");
  }

  if (plan.drive.sizeBytes < plan.image.minUsbSizeBytes) {
    throw new Error(
      `Drive is too small: ${plan.drive.sizeBytes} bytes available, ${plan.image.minUsbSizeBytes} bytes required.`,
    );
  }

  if (!hasTrustedChecksum(plan.image.checksumSha256)) {
    throw new Error(
      "This image does not have a trusted SHA-256 checksum. Live USB writes are blocked until the release manifest includes a real checksum.",
    );
  }

  if (plan.image.format === "raw.zst") {
    if (
      !hasTrustedChecksum(plan.image.sha256Compressed ?? "") ||
      !hasTrustedChecksum(plan.image.sha256Expanded ?? "") ||
      plan.image.sha256Compressed === plan.image.sha256Expanded ||
      plan.image.checksumSha256 !== plan.image.sha256Compressed ||
      !Number.isSafeInteger(plan.image.compressedSize) ||
      Number(plan.image.compressedSize) <= 0 ||
      plan.image.sizeBytes !== plan.image.compressedSize ||
      !Number.isSafeInteger(plan.image.expandedSize) ||
      Number(plan.image.expandedSize) < Number(plan.image.compressedSize) ||
      !Number.isSafeInteger(plan.image.minDeviceBytes) ||
      Number(plan.image.minDeviceBytes) < Number(plan.image.expandedSize) ||
      plan.image.minUsbSizeBytes !== plan.image.minDeviceBytes ||
      !plan.image.signatureUrl
    ) {
      throw new Error(
        "Canonical raw.zst releases require internally consistent signed sizes, signatures, and compressed and expanded SHA-256 digests.",
      );
    }
    if (options.canonicalRawZstdSupported !== true) {
      throw new Error(
        "Canonical raw.zst execution is blocked until this platform backend implements streaming decompression and expanded-device readback verification.",
      );
    }
  }
}
