import { UnsupportedPlatformError } from "./errors";
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
      throw new UnsupportedPlatformError(
        `Unsupported installer platform: ${process.platform}`,
      );
  }
}
