#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRegistryPath,
  getEntryRuntime,
  normalizeWorktreePath,
  readRegistry,
  updateRegistryEntry,
} from "./dev-server-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const worktree = normalizeWorktreePath(path.resolve(appDir, "../.."));
const registryPath = defaultRegistryPath();
const registry = readRegistry(registryPath);
const entry = registry.entries.find(
  (candidate) => candidate.worktree === worktree,
);

if (!entry) {
  console.error(
    "No shared dev server reservation for this worktree. Start one with `bun run dev:shared`.",
  );
  process.exit(1);
}

const runtime = await getEntryRuntime(entry);
if (!runtime.running) {
  console.error(
    `No running shared dev server for this worktree on port ${entry.uiPort}. Start one with \`bun run dev:shared\`.`,
  );
  process.exit(1);
}

const htmlPath = path.join(appDir, "index.html");
const now = new Date();
fs.utimesSync(htmlPath, now, now);
await updateRegistryEntry(
  worktree,
  { lastRebuildAt: now.toISOString() },
  { registryPath },
);

console.log(
  `[dev:rebuild] triggered Vite full-reload via ${path.relative(appDir, htmlPath)} on http://127.0.0.1:${entry.uiPort}`,
);
