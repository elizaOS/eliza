#!/usr/bin/env node
/**
 * Build the "core" package set (issue #10200).
 *
 * Ensures workspace package symlinks exist, then drives `run-turbo.ts run
 * build` over the leaf packages selected by package metadata. This
 * replaces the hand-maintained
 * `--filter=@elizaos/… (×27)` string that used to live inline in the root
 * `build:core` package.json script. The emitted Turbo invocation is identical to
 * the old inline list — same `run build --filter=…` args, same default Turbo
 * behaviour — so the six CI/deploy workflows and three test lanes that call
 * `bun run build:core` are unaffected. The only difference is that the package
 * set is now declarative data with a drift self-test instead of a wall of flags.
 *
 * Any extra args are forwarded to Turbo, so `bun build-core.ts --force` works.
 *
 * Usage:
 *   bun packages/scripts/build-core.ts            # build the core set
 *   bun packages/scripts/build-core.ts --force    # … forwarding extra turbo args
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCoreBuildPackages } from "./lib/script-metadata.ts";

export const CORE_BUILD_PACKAGES = resolveCoreBuildPackages();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_TURBO = path.join(SCRIPT_DIR, "run-turbo.ts");
export const BUILD_CORE_PREREQUISITE_SCRIPTS = ["ensure-workspace-symlinks.ts"];

/**
 * Whether this module is the process entrypoint.
 *
 * `import.meta.url` is always a normalized file URL, while `process.argv[1]`
 * is a platform-native filesystem path. Building a URL with string
 * interpolation leaves Windows backslashes and drive-letter syntax intact,
 * so the direct-execution guard silently fails there. Convert through Node's
 * URL API instead, matching the representation used for `import.meta.url`.
 */
export function isBuildCoreEntrypoint(moduleUrl, argvPath) {
  if (typeof argvPath !== "string" || argvPath.length === 0) return false;
  return moduleUrl === pathToFileURL(path.resolve(argvPath)).href;
}

/**
 * The Bun the repository pins (`packageManager: bun@x.y.z`). Several package
 * builds depend on bundler behaviour of that exact release: under another Bun,
 * plugin-elizacloud's shared `lib/config-env` external is emitted as an
 * extensionless relative import and the build fails only at its post-build
 * self-check. Consumers that build outside the pinned CI (for example a
 * product deploying its own Cloud) need the refusal up front.
 */
export function pinnedBunVersion(packageJsonText) {
  const manager = JSON.parse(packageJsonText).packageManager;
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manager ?? "");
  return match ? match[1] : null;
}

/** A refusal message when the running Bun is not the pinned one, else null. */
export function bunVersionProblem(pinned, running, env = process.env) {
  if (!pinned || !running || pinned === running) return null;
  if (env.ELIZA_ALLOW_UNPINNED_BUN === "1") return null;
  return (
    `[build-core] Bun ${running} is running, but this repository pins bun@${pinned} ` +
    `(package.json packageManager). Install it (for example \`bun upgrade --version ${pinned}\`) ` +
    `or set ELIZA_ALLOW_UNPINNED_BUN=1 to build anyway.`
  );
}

/**
 * The environment for the Turbo build. Type-emitting builds (`tsc` in
 * @elizaos/agent) exceed Node's default heap; CI sets an 8 GiB limit in each
 * workflow, so local and downstream builds get the same default unless the
 * caller already chose one.
 */
export function buildCoreEnvironment(env = process.env) {
  const options = env.NODE_OPTIONS ?? "";
  if (/--max-old-space-size(=|\s)/.test(options)) return { ...env };
  return {
    ...env,
    NODE_OPTIONS: `${options} --max-old-space-size=8192`.trim(),
  };
}

/** The exact `run-turbo.ts` argv for the core build, plus any forwarded args. */
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
  const pinned = pinnedBunVersion(
    readFileSync(path.join(SCRIPT_DIR, "..", "..", "package.json"), "utf8"),
  );
  const problem = bunVersionProblem(pinned, process.versions.bun);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const env = buildCoreEnvironment();
  for (const script of BUILD_CORE_PREREQUISITE_SCRIPTS) {
    console.log(`[build-core] running ${script}`);
    const prerequisite = spawnSync(
      process.execPath,
      [path.join(SCRIPT_DIR, script)],
      {
        stdio: "inherit",
        env,
      },
    );
    if (prerequisite.error) {
      console.error(
        `[build-core] could not run ${script}: ${prerequisite.error.message}\n` +
          `[build-core] re-run after \`bun install\`: bun run build:core`,
      );
      process.exit(1);
    }
    if (prerequisite.status !== 0) {
      console.error(
        `[build-core] ${script} failed (exit ${prerequisite.status ?? "signal"}). ` +
          `Re-run after \`bun install\`: bun run build:core`,
      );
      process.exit(prerequisite.status ?? 1);
    }
  }
  console.log(
    `[build-core] building ${CORE_BUILD_PACKAGES.length} core packages via turbo` +
      (extra.length ? ` (extra args: ${extra.join(" ")})` : ""),
  );
  const result = spawnSync(
    process.execPath,
    [RUN_TURBO, ...buildCoreTurboArgs(extra)],
    { stdio: "inherit", env },
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

if (isBuildCoreEntrypoint(import.meta.url, process.argv[1])) main();
