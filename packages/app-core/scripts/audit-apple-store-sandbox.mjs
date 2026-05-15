#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCoreRoot = path.resolve(__dirname, "..");
const entitlementsDir = path.join(
  appCoreRoot,
  "platforms/electrobun/entitlements",
);

const entitlementFiles = {
  parent: path.join(entitlementsDir, "mas.entitlements"),
  child: path.join(entitlementsDir, "mas-child.entitlements"),
  bun: path.join(entitlementsDir, "mas-bun.entitlements"),
};

const forbiddenEverywhere = [
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
];

const forbiddenOutsideBun = ["com.apple.security.cs.allow-jit"];
const jitSymbols = [
  "_pthread_jit_write_protect_np",
  "_pthread_jit_write_protect_supported_np",
  "_MAP_JIT",
];

const machoMagic = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
]);

function fail(message) {
  console.error(`apple-store-sandbox-audit: ${message}`);
  process.exitCode = 1;
}

function readEntitlements(filePath) {
  if (!existsSync(filePath)) {
    fail(`missing entitlements file: ${filePath}`);
    return "";
  }
  return readFileSync(filePath, "utf8");
}

function assertEntitlementAbsent(filePath, content, key) {
  if (content.includes(key)) {
    fail(`${path.relative(appCoreRoot, filePath)} must not contain ${key}`);
  }
}

function auditEntitlementFiles() {
  for (const [name, filePath] of Object.entries(entitlementFiles)) {
    const content = readEntitlements(filePath);
    for (const key of forbiddenEverywhere) {
      assertEntitlementAbsent(filePath, content, key);
    }
    if (name !== "bun") {
      for (const key of forbiddenOutsideBun) {
        assertEntitlementAbsent(filePath, content, key);
      }
    }
  }
}

function isMachO(filePath) {
  const st = statSync(filePath);
  if (!st.isFile() || st.size < 4) return false;
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(4);
  readSync(fd, buf, 0, 4, 0);
  closeSync(fd);
  return machoMagic.has(buf.readUInt32BE(0));
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function nmUndefinedSymbols(filePath) {
  const result = spawnSync("nm", ["-u", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return `${result.stdout}\n${result.stderr}`;
}

function auditBuiltApp(appPath) {
  if (!existsSync(appPath) || !appPath.endsWith(".app")) {
    fail(`--app must point at an existing .app bundle: ${appPath}`);
    return;
  }

  for (const filePath of walkFiles(appPath)) {
    if (!isMachO(filePath)) continue;
    const rel = path.relative(appPath, filePath).split(path.sep).join("/");
    const symbols = nmUndefinedSymbols(filePath);
    const importsJit = jitSymbols.some((symbol) => symbols.includes(symbol));
    if (importsJit && rel !== "Contents/MacOS/bun") {
      fail(`${rel} imports Apple JIT APIs; only Contents/MacOS/bun may do so`);
    }
  }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv);
auditEntitlementFiles();
if (args.app) auditBuiltApp(path.resolve(args.app));

if (process.exitCode) process.exit(process.exitCode);
console.log("apple-store-sandbox-audit: passed");
