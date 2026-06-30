#!/usr/bin/env node
/**
 * Build the "core" package set (issue #10200).
 *
 * Drives `run-turbo.mjs run build` over the leaf packages declared in
 * `build-core-packages.mjs`. This replaces the hand-maintained
 * `--filter=@elizaos/… (×27)` string that used to live inline in the root
 * `build:core` package.json script. The emitted Turbo invocation is identical to
 * the old inline list — same `run build --filter=…` args, same default Turbo
 * behaviour — so the six CI/deploy workflows and three test lanes that call
 * `bun run build:core` are unaffected. The only difference is that the package
 * set is now declarative data with a drift self-test instead of a wall of flags.
 *
 * Any extra args are forwarded to Turbo, so `node build-core.mjs --force` works.
 *
 * Usage:
 *   node packages/scripts/build-core.mjs            # build the core set
 *   node packages/scripts/build-core.mjs --force    # … forwarding extra turbo args
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BUILD_PACKAGES } from "./build-core-packages.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_TURBO = path.join(SCRIPT_DIR, "run-turbo.mjs");

/** The exact `run-turbo.mjs` argv for the core build, plus any forwarded args. */
export function buildCoreTurboArgs(extra = []) {
  return [
    "run",
    "build",
    ...CORE_BUILD_PACKAGES.map((name) => `--filter=${name}`),
    ...extra,
  ];
}

function main() {
  const extra = process.argv.slice(2);
  console.log(
    `[build-core] building ${CORE_BUILD_PACKAGES.length} core packages via turbo` +
      (extra.length ? ` (extra args: ${extra.join(" ")})` : ""),
  );
  const result = spawnSync(
    process.execPath,
    [RUN_TURBO, ...buildCoreTurboArgs(extra)],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error(
      `[build-core] could not start turbo: ${result.error.message}\n` +
        `[build-core] re-run after \`bun install\`: bun run build:core`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[build-core] turbo failed (exit ${result.status ?? "signal"}) building ` +
        `the ${CORE_BUILD_PACKAGES.length} core packages. The failing package + ` +
        `error are in turbo's output above. Re-run: bun run build:core`,
    );
  }
  process.exit(result.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
