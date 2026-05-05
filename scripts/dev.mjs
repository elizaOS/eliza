#!/usr/bin/env node
/**
 * @deprecated Use `bun run dev` (API + Vite) or `bun run dev:harness` (agent CLI watch).
 * Kept so `node scripts/dev.mjs` forwards to the harness for backwards compatibility.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const child = spawn("bun", ["run", "dev:harness"], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
