import type {
  InstallerStepId,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";
import { assertDriveMatchesExpected } from "./write-safety";

const labels: Record<InstallerStepId, string> = {
  "resolve-image": "Resolve image",
  checksum: "Validate checksum",
  write: "Write image",
  verify: "Finalize media",
  complete: "Complete",
};

export async function createPlatformWritePlan(
  backend: Pick<
    UsbInstallerBackend,
    "listRemovableDrives" | "listImages" | "canonicalRawZstdSupported"
  >,
  request: WriteRequest,
): Promise<WritePlan> {
  const [drives, images] = await Promise.all([
    backend.listRemovableDrives(),
    backend.listImages(),
  ]);
  const drive = drives.find((candidate) => candidate.id === request.driveId);
  if (!drive) throw new Error(`Unknown drive id: ${request.driveId}`);
  assertDriveMatchesExpected(request, drive);
  const image = images.find((candidate) => candidate.id === request.imageId);
  if (!image) throw new Error(`Unknown image id: ${request.imageId}`);
  if (image.format !== "raw.zst")
    throw new Error("Only signed raw.zst images are supported.");
  if (!request.acknowledgeDataLoss)
    throw new Error(
      "Data-loss acknowledgement is required before preparing media.",
    );
  const privilegedWriteImplemented = backend.canonicalRawZstdSupported === true;
  const blockedReason =
    drive.safety !== "safe-removable"
      ? "the target is not marked safe-removable."
      : drive.sizeBytes < image.minUsbSizeBytes
        ? `the target is ${Math.round(drive.sizeBytes / 1024 ** 3)} GiB but ${Math.round(image.minUsbSizeBytes / 1024 ** 3)} GiB is required.`
        : !request.dryRun && !privilegedWriteImplemented
          ? "canonical raw image writing is not available on this host."
          : null;
  return {
    request,
    drive,
    image,
    privilegedWriteImplemented,
    steps: (Object.keys(labels) as InstallerStepId[]).map((id) => ({
      id,
      label: labels[id],
      status: blockedReason
        ? "blocked"
        : request.dryRun
          ? "complete"
          : "pending",
      detail: blockedReason
        ? `Blocked: ${blockedReason}`
        : request.dryRun
          ? "Dry-run complete; no bytes were written."
          : "Waiting to start.",
    })),
  };
}

export class WriteRequestValidationError extends Error {
  override readonly name = "WriteRequestValidationError";
}

export function parseWriteRequest(value: unknown): WriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WriteRequestValidationError("Write request must be an object.");
  const request = value as Record<string, unknown>;
  for (const key of ["driveId", "imageId"]) {
    if (typeof request[key] !== "string" || !(request[key] as string).trim())
      throw new WriteRequestValidationError(`Write request requires ${key}.`);
  }
  if (
    typeof request.dryRun !== "boolean" ||
    typeof request.acknowledgeDataLoss !== "boolean"
  )
    throw new WriteRequestValidationError(
      "Write request requires boolean safety flags.",
    );
  if (request.expectedDrive !== undefined) {
    if (
      !request.expectedDrive ||
      typeof request.expectedDrive !== "object" ||
      Array.isArray(request.expectedDrive)
    )
      throw new WriteRequestValidationError("Invalid expected drive identity.");
    const drive = request.expectedDrive as Record<string, unknown>;
    if (
      typeof drive.devicePath !== "string" ||
      !drive.devicePath ||
      !Number.isSafeInteger(drive.sizeBytes) ||
      Number(drive.sizeBytes) <= 0
    )
      throw new WriteRequestValidationError(
        "Invalid expected drive path or size.",
      );
    for (const key of ["name", "stableId", "kernelDeviceIdentity"]) {
      if (
        drive[key] !== undefined &&
        (typeof drive[key] !== "string" || !drive[key])
      )
        throw new WriteRequestValidationError(`Invalid expected drive ${key}.`);
    }
  }
  return request as unknown as WriteRequest;
}
