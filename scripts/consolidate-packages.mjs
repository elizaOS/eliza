#!/usr/bin/env node
// Consolidate sibling packages into canonical homes.
// Usage: node scripts/consolidate-packages.mjs [--dry-run]

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DRY = process.argv.includes("--dry-run");

const log = (...a) => console.log(DRY ? "[dry]" : "[run]", ...a);

function sh(cmd) {
  log("$", cmd);
  if (!DRY) execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

function mvDir(from, to) {
  const src = path.join(ROOT, from);
  const dst = path.join(ROOT, to);
  if (!existsSync(src)) {
    log(`skip mv (missing): ${from}`);
    return;
  }
  if (existsSync(dst)) {
    log(`skip mv (dst exists): ${to}`);
    return;
  }
  log(`mv ${from} -> ${to}`);
  if (!DRY) {
    mkdirSync(path.dirname(dst), { recursive: true });
    // Use git mv if tracked, else fs rename
    try {
      execSync(`git mv "${from}" "${to}"`, { cwd: ROOT, stdio: "pipe" });
    } catch {
      execSync(`mv "${src}" "${dst}"`, { stdio: "inherit" });
    }
  }
}

function mvFile(from, to) {
  const src = path.join(ROOT, from);
  const dst = path.join(ROOT, to);
  if (!existsSync(src)) return;
  if (existsSync(dst)) return;
  log(`mv ${from} -> ${to}`);
  if (!DRY) {
    mkdirSync(path.dirname(dst), { recursive: true });
    try {
      execSync(`git mv "${from}" "${to}"`, { cwd: ROOT, stdio: "pipe" });
    } catch {
      execSync(`mv "${src}" "${dst}"`, { stdio: "inherit" });
    }
  }
}

function rmPath(p) {
  const full = path.join(ROOT, p);
  if (!existsSync(full)) return;
  log(`rm -rf ${p}`);
  if (!DRY) {
    try {
      execSync(`git rm -rf "${p}"`, { cwd: ROOT, stdio: "pipe" });
    } catch {
      rmSync(full, { recursive: true, force: true });
    }
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
}
function writeJson(p, obj) {
  log(`write ${p}`);
  if (!DRY)
    writeFileSync(path.join(ROOT, p), JSON.stringify(obj, null, 2) + "\n");
}
function writeText(p, content) {
  log(`write ${p}`);
  if (!DRY) {
    mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true });
    writeFileSync(path.join(ROOT, p), content);
  }
}

// ---------------- Step 1: directory + file moves ----------------

// 1a. ui-stories -> ui/stories
mvDir("packages/ui-stories", "packages/ui/stories");
// drop its package.json so it's not a workspace
rmPath("packages/ui/stories/package.json");

// 1b. shared-brand -> shared/src/brand + shared/assets + shared/scripts/sync-to-public.mjs
mvDir("packages/shared-brand/src", "packages/shared/src/brand");
mvDir("packages/shared-brand/assets", "packages/shared/assets");
mvFile(
  "packages/shared-brand/scripts/sync-to-public.mjs",
  "packages/shared/scripts/sync-to-public.mjs",
);
mvDir("packages/shared-brand/public", "packages/shared/src/brand-public");
rmPath("packages/shared-brand");

// 1c. brand (older variant) -> shared/src/brand-classic (kept distinct because content differs)
mvDir("packages/brand/src", "packages/shared/src/brand-classic");
mvDir("packages/brand/assets", "packages/shared/assets-classic");
rmPath("packages/brand");

// 1d. scenario-schema -> scenario-runner/schema
mvFile(
  "packages/scenario-schema/index.js",
  "packages/scenario-runner/schema/index.js",
);
mvFile(
  "packages/scenario-schema/index.d.ts",
  "packages/scenario-runner/schema/index.d.ts",
);
rmPath("packages/scenario-schema");

// 1e. native consolidation
mvDir("packages/ios-native-deps", "packages/native/ios-deps");
mvDir("packages/native-plugins", "packages/native/plugins");
mvDir("packages/bun-ios-runtime", "packages/native/bun-runtime");

// 1f. hardware-catalog -> shared/src/hardware-catalog
mvFile(
  "packages/hardware-catalog/src/index.ts",
  "packages/shared/src/hardware-catalog/index.ts",
);
rmPath("packages/hardware-catalog");

// 1g. os-usb-installer -> os/usb-installer
mvDir("packages/os-usb-installer", "packages/os/usb-installer");

// 1h. elizaos-setup -> os/setup
mvDir("packages/elizaos-setup", "packages/os/setup");

// 1i. cloud-test-mocks + cloud-e2e -> packages/test/<>
mvDir("packages/cloud-test-mocks", "packages/test/cloud-mocks");
mvDir("packages/cloud-e2e", "packages/test/cloud-e2e");

// 1j. checkout-shared -> shared/src/checkout
mvFile(
  "packages/checkout-shared/src/index.ts",
  "packages/shared/src/checkout/index.ts",
);
rmPath("packages/checkout-shared");

// 1k. steward-session-client -> shared/src/steward-session-client
mvFile(
  "packages/steward-session-client/src/index.ts",
  "packages/shared/src/steward-session-client/index.ts",
);
rmPath("packages/steward-session-client");

// ---------------- Step 2: update root package.json (workspaces + devDependencies) ----------------

if (!DRY) {
  const root = readJson("package.json");
  const wantedWs = new Set(root.workspaces);
  wantedWs.add("packages/native/*");
  wantedWs.add("packages/os/*");
  wantedWs.add("packages/os/android/*");
  wantedWs.add("packages/test/cloud-mocks");
  wantedWs.add("packages/test/cloud-e2e");
  root.workspaces = [...wantedWs];

  const droppedDeps = [
    "@elizaos/ui-stories",
    "@elizaos/shared-brand",
    "@elizaos/brand",
    "@elizaos/scenario-schema",
    "@elizaos/hardware-catalog",
    "@elizaos/checkout-shared",
    "@elizaos/steward-session-client",
    "@elizaos/cloud-test-mocks",
    "@elizaos/cloud-e2e",
    "@elizaos/os-usb-installer",
    // @elizaos/setup is the elizaos-setup pkg name
    "@elizaos/setup",
    "@elizaos/ios-native-deps",
    "@elizaos/bun-ios-runtime",
  ];
  for (const block of ["dependencies", "devDependencies"]) {
    if (root[block]) {
      for (const d of droppedDeps) delete root[block][d];
    }
  }
  writeJson("package.json", root);
} else {
  log("would update root package.json workspaces + drop merged deps");
}

// ---------------- Step 3: update shared/package.json (files + scripts) ----------------

if (!DRY) {
  const shared = readJson("packages/shared/package.json");
  const wantedFiles = new Set([
    ...(shared.files || []),
    "dist",
    "assets",
    "assets-classic",
  ]);
  shared.files = [...wantedFiles];
  // sync script lives in scripts/ now
  shared.scripts = shared.scripts || {};
  if (!shared.scripts.sync)
    shared.scripts.sync = "node scripts/sync-to-public.mjs";
  // include brand.css and brand-classic css in exports if not already covered by glob
  shared.exports = shared.exports || {};
  if (!shared.exports["./brand.css"]) {
    shared.exports["./brand.css"] = "./dist/brand/brand.css";
  }
  if (!shared.exports["./brand-classic.css"]) {
    shared.exports["./brand-classic.css"] = "./dist/brand-classic/brand.css";
  }
  if (!shared.exports["./assets/*"]) {
    shared.exports["./assets/*"] = "./assets/*";
  }
  writeJson("packages/shared/package.json", shared);
} else {
  log(
    "would update packages/shared/package.json (files, exports, sync script)",
  );
}

// ---------------- Step 4: update scenario-runner/package.json ----------------

if (!DRY) {
  const sr = readJson("packages/scenario-runner/package.json");
  delete sr.dependencies["@elizaos/scenario-schema"];
  const wantedFiles = new Set([...(sr.files || []), "schema"]);
  sr.files = [...wantedFiles];
  sr.exports = sr.exports || {};
  sr.exports["./schema"] = {
    types: "./schema/index.d.ts",
    default: "./schema/index.js",
  };
  writeJson("packages/scenario-runner/package.json", sr);
} else {
  log(
    "would update scenario-runner/package.json (drop schema dep, add schema export)",
  );
}

// ---------------- Step 5: update UI package.json (stories scripts) ----------------

if (!DRY && existsSync(path.join(ROOT, "packages/ui/package.json"))) {
  const ui = readJson("packages/ui/package.json");
  ui.scripts = ui.scripts || {};
  if (!ui.scripts["stories:dev"])
    ui.scripts["stories:dev"] = "vite --config stories/vite.config.ts";
  if (!ui.scripts["stories:build"])
    ui.scripts["stories:build"] = "vite build --config stories/vite.config.ts";
  writeJson("packages/ui/package.json", ui);
} else {
  log(
    "would add stories:dev/stories:build scripts to packages/ui/package.json",
  );
}

// ---------------- Step 6: rewrite imports ----------------

const IMPORT_RENAMES = [
  // longer/specific subpaths first so partial replacements don't shadow
  ["@elizaos/shared-brand/brand.css", "@elizaos/shared/brand/brand.css"],
  ["@elizaos/shared-brand/sync", "@elizaos/shared/sync"],
  ["@elizaos/shared-brand/assets", "@elizaos/shared/assets"],
  ["@elizaos/shared-brand", "@elizaos/shared/brand"],
  ["@elizaos/brand/brand.css", "@elizaos/shared/brand-classic/brand.css"],
  ["@elizaos/brand", "@elizaos/shared/brand-classic"],
  ["@elizaos/scenario-schema", "@elizaos/scenario-runner/schema"],
  ["@elizaos/hardware-catalog", "@elizaos/shared/hardware-catalog"],
  ["@elizaos/checkout-shared", "@elizaos/shared/checkout"],
  ["@elizaos/steward-session-client", "@elizaos/shared/steward-session-client"],
  // relative refs to sync-to-public.mjs from packages/* (predev/prebuild)
  [
    "../shared-brand/scripts/sync-to-public.mjs",
    "../shared/scripts/sync-to-public.mjs",
  ],
  // os-usb-installer / elizaos-setup paths used in scripts (best-effort)
  ["packages/os-usb-installer", "packages/os/usb-installer"],
  ["packages/elizaos-setup", "packages/os/setup"],
  ["packages/ios-native-deps", "packages/native/ios-deps"],
  ["packages/native-plugins", "packages/native/plugins"],
  ["packages/bun-ios-runtime", "packages/native/bun-runtime"],
  ["packages/cloud-test-mocks", "packages/test/cloud-mocks"],
  ["packages/cloud-e2e", "packages/test/cloud-e2e"],
  ["packages/shared-brand", "packages/shared"],
  ["packages/brand", "packages/shared"],
  ["packages/scenario-schema", "packages/scenario-runner"],
  ["packages/hardware-catalog", "packages/shared"],
  ["packages/checkout-shared", "packages/shared"],
  ["packages/steward-session-client", "packages/shared"],
  ["packages/ui-stories", "packages/ui/stories"],
];

const EXT_OK = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".html",
  ".css",
  ".scss",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".vite",
  "out",
  "coverage",
  ".pnpm-store",
  ".claude",
  "worktrees",
  "eliza",
  ".venv",
  "venv",
  "__pycache__",
  ".husky",
  ".vscode",
  ".idea",
  "target",
  "vendor",
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    // skip any dist-* and build-* output dirs
    if (
      entry.isDirectory() &&
      (entry.name.startsWith("dist-") || entry.name.startsWith("build-"))
    )
      continue;
    // skip platform output dirs
    if (entry.name === "ios" && existsSync(path.join(dir, entry.name, "App")))
      continue;
    if (
      entry.name === "android" &&
      existsSync(path.join(dir, entry.name, "build.gradle"))
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (
        EXT_OK.has(ext) ||
        entry.name === "package.json" ||
        entry.name === "tsconfig.json"
      ) {
        files.push(full);
      }
    }
  }
  return files;
}

log("scanning files for import rewrites...");
const allFiles = walk(ROOT);
log(`scanned ${allFiles.length} files`);

let changedCount = 0;
for (const file of allFiles) {
  if (file === __filename) continue;
  // never rewrite the lockfile
  if (
    path.basename(file) === "bun.lock" ||
    path.basename(file) === "package-lock.json"
  )
    continue;
  let txt;
  try {
    txt = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  let out = txt;
  for (const [from, to] of IMPORT_RENAMES) {
    if (out.includes(from)) {
      out = out.split(from).join(to);
    }
  }
  if (out !== txt) {
    changedCount++;
    if (DRY) {
      log(`would rewrite ${path.relative(ROOT, file)}`);
    } else {
      writeFileSync(file, out);
    }
  }
}
log(`import rewrites: ${changedCount} files`);

// ---------------- Step 7: regenerate lockfile ----------------

if (!DRY) {
  sh("bun install");
} else {
  log("would run: bun install");
}

log("done.");
