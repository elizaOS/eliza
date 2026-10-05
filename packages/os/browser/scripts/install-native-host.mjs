#!/usr/bin/env node
/** Registers an explicitly installed Linux native host for the single packaged extension identity. */
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const hostIndex = args.indexOf("--host");
const directoryIndex = args.indexOf("--manifest-dir");
const hostPath = hostIndex >= 0 ? args[hostIndex + 1] : undefined;
const directory =
  directoryIndex >= 0
    ? args[directoryIndex + 1]
    : path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "chromium",
        "NativeMessagingHosts",
      );
if (
  process.platform !== "linux" ||
  !hostPath ||
  !path.isAbsolute(hostPath) ||
  !directory ||
  !path.isAbsolute(directory)
) {
  throw new Error(
    "Usage: install-native-host.mjs --host /installed/native-host.mjs [--manifest-dir /absolute/directory]",
  );
}
await access(hostPath, constants.X_OK);
await mkdir(directory, { recursive: true, mode: 0o700 });
const manifestPath = path.join(directory, "ai.elizaos.browser.json");
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      name: "ai.elizaos.browser",
      description: "elizaOS authenticated browser connection",
      path: hostPath,
      type: "stdio",
      allowed_origins: ["chrome-extension://pmldpcoefklbdbgmggcejkfoinmjfeio/"],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${manifestPath}\n`);
