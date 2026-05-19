export {
  DEFAULT_ELIZAOS_IMAGES,
  DryRunUsbInstallerBackend,
  MOCK_REMOVABLE_DRIVES,
} from "./dry-run-backend";
export { LinuxUsbInstallerBackend } from "./linux-backend";
export { MacOsUsbInstallerBackend } from "./macos-backend";
export { detectPlatformId, PLATFORM_NOTES } from "./platform-notes";
export type {
  DriveSafety,
  ElizaOsImage,
  InstallerStep,
  InstallerStepId,
  InstallerStepStatus,
  PlatformId,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";
export { WindowsUsbInstallerBackend } from "./windows-backend";

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
