#!/usr/bin/env node
/** Install checksum-pinned setup tools; --strict makes any failure fatal. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installPinnedPlatformTools } from "./platform-tools-installer.mjs";
import { installPinnedSideloader } from "./sideloader-installer.mjs";

const args = process.argv.slice(2);
if (
  args.some((arg) => !["--strict", "--best-effort"].includes(arg)) ||
  (args.includes("--strict") && args.includes("--best-effort"))
) {
  throw new Error("Usage: node vendor/download.mjs [--strict | --best-effort]");
}
const strict = args.includes("--strict");
const platform = process.platform;
const vendorRoot = join(homedir(), ".elizaos/flasher/vendor/bin", platform);
const checksums = JSON.parse(
  readFileSync(new URL("./checksums.json", import.meta.url), "utf8"),
);

async function main() {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error("Unsupported vendor platform: " + platform);
  }
  try {
    const response = await fetch("https://dl.google.com", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500) throw new Error("Download service unavailable");
  } catch (error) {
    if (strict) throw error;
    console.warn(
      "[vendor] Network unavailable; run bun run vendor:update when online.",
    );
    return;
  }
  const tasks = [
    [
      "platform-tools",
      () =>
        installPinnedPlatformTools({
          vendorRoot,
          platform,
          config: checksums["platform-tools"],
        }),
    ],
    [
      "sideloader",
      () =>
        installPinnedSideloader({
          vendorRoot,
          platform,
          arch: process.arch,
          config: checksums.sideloader,
        }),
    ],
  ];
  let failed = false;
  for (const [name, install] of tasks) {
    try {
      const destination = await install();
      console.log("[vendor] " + name + " installed: " + destination);
    } catch (error) {
      failed = true;
      console.error("[vendor] " + name + " failed:", error);
    }
  }
  if (failed) {
    console.warn(
      "[vendor] Some tools are unavailable. Run bun run vendor:update to retry.",
    );
    if (strict) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[vendor] Installation failed:", error);
  process.exitCode = 1;
});
