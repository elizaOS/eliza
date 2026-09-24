// Starts the packaged loopback backend and opens the USB installer window.
// Electrobun ships TypeScript sources that are incompatible with this package's
// exactOptionalPropertyTypes setting, so its entrypoint is verified by the
// Electrobun/Bun build rather than included in the renderer TypeScript project.
import { join } from "node:path";
import { BrowserWindow, PATHS } from "electrobun/bun";
import { createUsbInstallerHandler } from "../server";
import { createPackagedAppHandler } from "../src/packaged-app-handler";
import { configurePackagedReleaseSequenceState } from "../src/packaged-runtime-config";

const hostname = "127.0.0.1";
configurePackagedReleaseSequenceState();
const configuredPort = Number(process.env.ELIZAOS_USB_INSTALLER_PORT ?? 3742);
if (
  !Number.isSafeInteger(configuredPort) ||
  configuredPort < 1 ||
  configuredPort > 65_535
) {
  throw new Error(
    "ELIZAOS_USB_INSTALLER_PORT must be an integer from 1 through 65535.",
  );
}

const server = Bun.serve({
  hostname,
  port: configuredPort,
  fetch: createPackagedAppHandler(
    join(PATHS.RESOURCES_FOLDER, "app", "dist"),
    createUsbInstallerHandler(),
  ),
});

new BrowserWindow({
  title: "elizaOS USB Installer",
  frame: { x: 80, y: 80, width: 1120, height: 760 },
  url: `http://${hostname}:${server.port}/`,
  sandbox: true,
});
