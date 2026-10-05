/**
 * Starts the Cloud browser fixture against its worker-owned local API.
 * The interactive development launcher selects staging by default; this
 * harness preserves the isolated stack's endpoint and credential scope while
 * reusing the canonical Node-backed Vite resolver and signal forwarding.
 */
import { fileURLToPath } from "node:url";
import { resolveViteCommand } from "../../../app/scripts/lib/dev-ui-vite.ts";
import { spawnMirroredChild } from "../../../app/scripts/lib/spawn-mirrored-child.ts";

const appDir = fileURLToPath(new URL("../../../app/", import.meta.url));
const vite = resolveViteCommand({
  appDir,
  viteArgs: ["--host", "127.0.0.1"],
});
spawnMirroredChild(vite.command, vite.args, {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
});
