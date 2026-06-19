#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.RELEASE_VERSION;
if (!version) {
  console.error("RELEASE_VERSION environment variable is required");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Set package version to ${version}`);
