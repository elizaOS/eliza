/**
 * Filesystem helpers (readText / readJson / ensureDirectory) shared by the
 * prompts package codegen scripts (the plugin-action-spec and action-docs
 * generators).
 */

import fs from "node:fs";

export function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

export function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

export function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
