#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// build-flatpak.mjs — Flatpak builder driver, store + direct variants.
//
// Usage:
//   MILADY_BUILD_VARIANT=store bun run build:flatpak
//   MILADY_BUILD_VARIANT=direct bun run build:flatpak
//   bun run build:flatpak --variant store
//
// Picks the correct manifest based on MILADY_BUILD_VARIANT (or --variant),
// invokes flatpak-builder, and emits a bundle into ./dist-flatpak/.
//
// Defaults to `store` when the variant is unspecified. The store variant
// targets Flathub (locked-down sandbox); the direct variant produces the
// power-user build with full $HOME access.
//
// Requires `flatpak-builder` on $PATH. On macOS dev hosts the script
// short-circuits with a friendly skip message — Flatpak only builds on
// Linux.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLATPAK_DIR = resolve(HERE, "../packaging/flatpak");
const REPO_DIR = resolve(HERE, "../../../dist-flatpak/repo");
const BUILD_DIR = resolve(HERE, "../../../dist-flatpak/build");
const BUNDLE_PATH = resolve(HERE, "../../../dist-flatpak/elizaos-app.flatpak");

const APP_ID = "ai.elizaos.App";

function parseVariant() {
  const argIdx = process.argv.indexOf("--variant");
  const fromArg = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
  const raw = fromArg || process.env.MILADY_BUILD_VARIANT || "store";
  const variant = raw.toLowerCase();
  if (variant !== "store" && variant !== "direct") {
    throw new Error(
      `MILADY_BUILD_VARIANT must be 'store' or 'direct' (got '${raw}').`,
    );
  }
  return variant;
}

function manifestFor(variant) {
  const file =
    variant === "store" ? "ai.elizaos.App.store.yml" : "ai.elizaos.App.yml";
  const path = resolve(FLATPAK_DIR, file);
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  return path;
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} exited with status ${r.status}`);
  }
}

function which(cmd) {
  const r = spawnSync("which", [cmd], { stdio: "pipe" });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

async function main() {
  if (process.platform !== "linux") {
    console.error(
      "build-flatpak: skipping — Flatpak only builds on Linux. " +
        "(Detected platform: " +
        process.platform +
        ")",
    );
    process.exit(0);
  }

  const variant = parseVariant();
  const manifest = manifestFor(variant);

  console.log(`build-flatpak: variant=${variant}`);
  console.log(`build-flatpak: manifest=${manifest}`);

  if (!which("flatpak-builder")) {
    console.error(
      "build-flatpak: flatpak-builder not found on $PATH. " +
        "Install it with `sudo apt install flatpak flatpak-builder` " +
        "or `sudo dnf install flatpak flatpak-builder`.",
    );
    process.exit(1);
  }

  // Build.
  run(
    "flatpak-builder",
    [
      `--repo=${REPO_DIR}`,
      "--force-clean",
      "--user",
      "--install-deps-from=flathub",
      BUILD_DIR,
      manifest,
    ],
    { cwd: FLATPAK_DIR },
  );

  // Bundle into a single .flatpak file users can side-load.
  run("flatpak", ["build-bundle", REPO_DIR, BUNDLE_PATH, APP_ID], {
    cwd: FLATPAK_DIR,
  });

  console.log("\nbuild-flatpak: done.");
  console.log(`  variant: ${variant}`);
  console.log(`  bundle:  ${BUNDLE_PATH}`);
  console.log(`  install: flatpak --user install ${BUNDLE_PATH}`);
}

main().catch((err) => {
  console.error("build-flatpak: failed:", err.message);
  process.exit(1);
});
