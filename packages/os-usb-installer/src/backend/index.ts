export {
  DEFAULT_ELIZAOS_IMAGES,
  DryRunUsbInstallerBackend,
  MOCK_REMOVABLE_DRIVES,
} from "./dry-run-backend";
export { detectPlatformId, PLATFORM_NOTES } from "./platform-notes";
export { MacOsUsbInstallerBackend } from "./macos-backend";
export { LinuxUsbInstallerBackend } from "./linux-backend";
export { WindowsUsbInstallerBackend } from "./windows-backend";
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

import { MacOsUsbInstallerBackend } from "./macos-backend";
import { LinuxUsbInstallerBackend } from "./linux-backend";
import { WindowsUsbInstallerBackend } from "./windows-backend";
import { DryRunUsbInstallerBackend } from "./dry-run-backend";
import type { UsbInstallerBackend } from "./types";

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
