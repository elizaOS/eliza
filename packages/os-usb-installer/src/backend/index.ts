export {
  DEFAULT_ELIZAOS_IMAGES,
  DryRunUsbInstallerBackend,
  MOCK_REMOVABLE_DRIVES,
} from "./dry-run-backend";
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
