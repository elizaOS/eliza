#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

if (process.platform !== "win32") {
  console.error(
    "[desktop-playwright] Packaged Playwright validation is a Windows-only CI gate. Run `bun run test:desktop:playwright:windows` on Windows or use the release workflow.",
  );
  process.exit(1);
}

const result = spawnSync("bun", ["run", "test:desktop:playwright:windows"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
