#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const registryRoot = path.resolve(__dirname, "..");
const publicDir = path.join(registryRoot, "site", "public");

const files = [
  "generated-registry.json",
  "index.json",
  "registry-summary.json",
  "CNAME",
];

fs.mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  const source = path.join(registryRoot, file);
  if (!fs.existsSync(source)) {
    continue;
  }
  fs.copyFileSync(source, path.join(publicDir, file));
}

console.log(`Prepared ${publicDir}`);
