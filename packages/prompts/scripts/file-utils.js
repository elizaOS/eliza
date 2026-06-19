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
