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
}

export function assertWritePlanAllowed(plan: WritePlan): void {
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
}
