#!/usr/bin/env node
/**
 * Routes local Flatpak packaging to the real Electrobun desktop artifact and
 * refuses the legacy CLI-based Flathub manifest, which is not an acceptable
 * store submission or a representation of the shipped desktop application.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageScript = path.join(scriptDir, "package-electrobun-flatpak.mjs");

function requestedVariant() {
  const index = process.argv.indexOf("--variant");
  return (
    (index >= 0 ? process.argv[index + 1] : undefined) ??
    process.env.ELIZA_BUILD_VARIANT ??
    "direct"
  ).toLowerCase();
}

const variant = requestedVariant();
if (variant === "store") {
  console.error(
    [
      "build-flatpak: Flathub store packaging is intentionally blocked.",
      "The retired manifest installed the elizaOS CLI instead of the Electrobun desktop and required build-time network access.",
      "A human maintainer must first obtain the required Flathub policy exception and provide a fully offline source manifest.",
      "The canonical release workflow still produces and tests a side-loadable Flatpak of the real Electrobun application.",
    ].join("\n"),
  );
  process.exit(1);
}
if (variant !== "direct") {
  console.error(`build-flatpak: unknown variant ${JSON.stringify(variant)}`);
  process.exit(1);
}
if (process.platform !== "linux") {
  console.error(
    `build-flatpak: Flatpak packaging requires Linux, got ${process.platform}`,
  );
  process.exit(1);
}

const forwardedArgs = process.argv
  .slice(2)
  .filter(
    (arg, index, all) => arg !== "--variant" && all[index - 1] !== "--variant",
  );
execFileSync(process.execPath, [packageScript, ...forwardedArgs], {
  stdio: "inherit",
});
