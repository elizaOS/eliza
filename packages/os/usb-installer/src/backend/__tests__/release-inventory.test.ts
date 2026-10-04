import { afterEach, expect, it, vi } from "vitest";
import { DryRunUsbInstallerBackend } from "../dry-run-backend";
import { LinuxUsbInstallerBackend } from "../linux-backend";
import { MacOsUsbInstallerBackend } from "../macos-backend";
import { WindowsUsbInstallerBackend } from "../windows-backend";

afterEach(() => vi.unstubAllEnvs());
it("dry-run discovery does not invent downloadable production images", async () => {
  expect(await new DryRunUsbInstallerBackend().listImages()).toEqual([]);
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
