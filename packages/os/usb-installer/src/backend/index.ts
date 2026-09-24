// Implements platform-specific USB installer backend safety behavior.
export {
  DEFAULT_ELIZAOS_IMAGES,
  DryRunUsbInstallerBackend,
  MOCK_REMOVABLE_DRIVES,
} from "./dry-run-backend";
export {
  assertEd25519Signature,
  decodeDetachedEd25519Signature,
  loadPinnedEd25519PublicKey,
  publicKeyFingerprint,
  RELEASE_PUBLIC_KEY_ENV,
} from "./ed25519-trust";
export { LinuxUsbInstallerBackend } from "./linux-backend";
export { MacOsUsbInstallerBackend } from "./macos-backend";
export { detectPlatformId, PLATFORM_NOTES } from "./platform-notes";
export type {
  RawImagePipelineOptions,
  RawImageTarget,
  RawImageWriteReceipt,
} from "./raw-image-pipeline";
export {
  createArtifactSignaturePayload,
  writeVerifiedRawImage,
} from "./raw-image-pipeline";
export {
  DEFAULT_RELEASE_MANIFEST_URL,
  fetchReleaseImages,
  parseReleaseManifest,
} from "./release-manifest";
export type { ReleaseSequenceStore } from "./release-sequence-store";
export {
  configuredReleaseSequenceStore,
  FileReleaseSequenceStore,
  RELEASE_SEQUENCE_STATE_PATH_ENV,
} from "./release-sequence-store";
export type {
  DriveSafety,
  ElizaOsImage,
  InstallerStep,
  InstallerStepId,
  InstallerStepStatus,
  PlatformId,
  RemovableDrive,
  UsbInstallerBackend,
  WriteExecutionOptions,
  WritePlan,
  WriteRequest,
} from "./types";
export { WindowsUsbInstallerBackend } from "./windows-backend";
export {
  assertDriveMatchesExpected,
  assertWritePlanAllowed,
  hasTrustedChecksum,
} from "./write-safety";

import { DryRunUsbInstallerBackend } from "./dry-run-backend";
import { LinuxUsbInstallerBackend } from "./linux-backend";
import { MacOsUsbInstallerBackend } from "./macos-backend";
import type { UsbInstallerBackend } from "./types";
import { WindowsUsbInstallerBackend } from "./windows-backend";

export function createPlatformBackend(): UsbInstallerBackend {
  switch (process.platform) {
    case "darwin":
      return new MacOsUsbInstallerBackend();
    case "linux":
      return new LinuxUsbInstallerBackend();
    case "win32":
      return new WindowsUsbInstallerBackend();
    default:
      return new DryRunUsbInstallerBackend();
  }
}
