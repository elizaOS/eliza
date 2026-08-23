import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Returns the BrowserWindow sources actually shipped by an Electrobun package.
 * Clean installs can contain only the shared `dist` source; Electrobun's own
 * postinstall may later mirror it into the platform-specific distribution.
 */
export function findElectrobunBrowserWindowEntrypoints(
  packageRoot,
  pathExists = existsSync,
) {
  return ["dist", "dist-linux-x64"]
    .map((distName) =>
      path.join(
        packageRoot,
        distName,
        "api",
        "bun",
        "core",
        "BrowserWindow.ts",
      ),
    )
    .filter((candidate) => pathExists(candidate));
}
