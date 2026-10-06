import { afterEach, expect, it, vi } from "vitest";
import { LinuxUsbInstallerBackend } from "./linux-backend";
import { MacOsUsbInstallerBackend } from "./macos-backend";
import { createPlatformBackend } from "./platform-backend";
import { WindowsUsbInstallerBackend } from "./windows-backend";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("unsupported hosts fail without fabricated drive discovery", () => {
  vi.stubGlobal("process", { platform: "freebsd" });
  expect(createPlatformBackend).toThrow(
    "Unsupported installer platform: freebsd",
  );
});
it.each([
  LinuxUsbInstallerBackend,
  MacOsUsbInstallerBackend,
  WindowsUsbInstallerBackend,
])(
  "propagates invalid production release configuration (%s)",
  async (Backend) => {
    vi.stubEnv(
      "ELIZAOS_RELEASE_MANIFEST_URL",
      "http://invalid.example/manifest.json",
    );
    await expect(new Backend().listImages()).rejects.toThrow("must be HTTPS");
  },
);
