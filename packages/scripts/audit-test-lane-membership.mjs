#!/usr/bin/env node
/**
 * Fail-closed completeness gate for test-lane membership (issue: opt-in
 * `elizaos.scripts.testLanes` tagging has no completeness check, so a package
 * can carry a real `test` script that no required CI job ever runs).
 *
 * Every named workspace package whose `package.json` declares a test-shaped
 * script (`test`, or any of run-all-tests.mjs's `EXTRA_SCRIPT_NAMES`), or that
 * contains a `*.test.*` / `*.spec.*` file with no test-shaped script at all,
 * must be accounted for exactly one way:
 *   (a) under `plugins/` — covered by the `tests_plugins` CI job;
 *   (b) declaring `elizaos.scripts.testLanes` with a known lane (a lane name a
 *       root script actually consumes via `--lane=<name>`, e.g. server/client)
 *       — covered by `tests_server` / `tests_client`;
 *   (c) inside a `packages/scripts/test-cloud-run.mjs` `computeTestRoots()`
 *       root — covered by the bespoke cloud lane (`test:cloud`, cloud-tests.yml);
 *       imported directly so this can never drift from the real cloud runner; or
 *   (d) named in `TEST_LANE_MEMBERSHIP_EXCLUSIONS` below with a durable, still-
 *       true reason. An exclusion whose package now matches (a)/(b)/(c), or no
 *       longer carries a test-shaped script/file, is stale and throws — the
 *       same fail-closed contract as `SCRIPT_TEST_EXCLUSIONS` in
 *       lib/script-test-inventory.mjs.
 *
 * A malformed `testLanes` declaration (not a non-empty array of known lanes)
 * is always a hard failure — it is a mistake to fix, never something to
 * document into the exclusion map.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeGitRepositoryPath } from "./lib/repository-file-integrity.mjs";
import { resolveTestLaneDeclarations } from "./lib/script-metadata.mjs";
import { execFileSync } from "./lib/spawn-sync-captured.mjs";
import { listPackages } from "./lib/workspaces.mjs";
import { computeTestRoots } from "./test-cloud-run.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// Mirrors run-all-tests.mjs's EXTRA_SCRIPT_NAMES exactly. Not imported: that
// module parses process.argv and can exit(2) at import time on an unrelated
// CLI's argv, so this file keeps its own copy and self-checks it against the
// real source text below (assertExtraScriptNamesCurrent) instead of trusting
// two hand-maintained lists to stay in sync silently.
export const EXTRA_SCRIPT_NAMES = [
  "test:integration",
  "test:e2e",
  "test:playwright",
  "test:ui",
  "test:live",
];

// Any *.test.* / *.spec.* (dot or underscore form, any single trailing
// extension) — deliberately broader than run-all-tests.mjs's own
// TEST_FILE_PATTERN (which only recognizes the ts/tsx/js/jsx/mjs/cjs family):
// this check exists to catch a maintained test file a script never runs at
// all, so it must not itself miss an exotic extension.
const TEST_FILE_PATTERN = /[._](?:test|spec)\.[^./]+$/i;

const PLUGINS_DIR = "plugins";

/**
 * Documented, fail-closed exceptions: a package with a test-shaped script (or
 * test/spec files) that is not under plugins/, not lane-tagged, and not a
 * cloud bespoke root, with the reason it is not silently broken. Each entry
 * is re-validated on every run — see validateExclusions — and THROWS the
 * moment it goes stale.
 */
export const TEST_LANE_MEMBERSHIP_EXCLUSIONS = new Map([
  [
    "packages/app-core/platforms/electrobun",
    "full `test` script (vitest, unfiltered config) is not lane-tagged; only a hand-picked 6-file subset (desktop-window/rpc-handlers/surface-windows/host/application-menu tests) runs, and only post-merge via test.yml's push-to-develop trigger, never as a PR gate. The untested remainder may carry native/macOS-only content unsafe for the shared ubuntu-24.04 lane runners, so this needs an owner decision (curate a safe subset into a lane, or accept post-merge-only coverage explicitly) rather than a blind tag.",
  ],
  [
    "packages/cloud/e2e",
    "plain `test` script is a Playwright suite against a live stack; deliberately excluded from the fast/no-cloud lanes (NO_CLOUD_PACKAGE_DIRS in run-all-tests.mjs) and run nightly instead via monetized-loop-nightly.yml's `cloud:e2e` step (schedule-only, not a PR gate) — the same deliberate exclusion this repo already applies to other e2e/live suites, not an oversight.",
  ],
  [
    "packages/homepage",
    "plain `test` script (bun:test suite covering contact, wallet-linking, onboarding, and auth-return paths) runs only in the separate Quality (Extended) workflow (quality.yml), which triggers on push to develop/main or PRs targeting main, never on PRs targeting develop — this repo's actual contribution target (see CONTRIBUTING.md). `test:e2e` is separately excluded from the root e2e sweep via ROOT_PR_E2E_EXCLUDED_PACKAGE_DIRS for GPU/timing-budget reasons. Needs an owner decision on lane membership for the plain `test` script.",
  ],
]);

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function isUnderPrefix(dir, prefixDir) {
  return dir === prefixDir || dir.startsWith(`${prefixDir}/`);
}

// computeTestRoots() roots nest with a package dir in EITHER direction: some
// are a subdirectory of the package (cloudRoutingTests = routing/src, under
// packages/cloud/routing) while others are the parent of several packages
// (cloudServicesRoot = packages/cloud/services, over every services/* leaf).
// A package is covered if either path contains the other.
function overlapsPackageDir(root, packageDir) {
  return isUnderPrefix(packageDir, root) || isUnderPrefix(root, packageDir);
}

/** Test-shaped script names present on one package's `scripts`, in order. */
export function testShapedScriptNames(scripts) {
  if (!scripts || typeof scripts !== "object") return [];
  const names = [];
  if (typeof scripts.test === "string" && scripts.test.trim().length > 0) {
    names.push("test");
  }
  for (const extra of EXTRA_SCRIPT_NAMES) {
    if (
      typeof scripts[extra] === "string" &&
      scripts[extra].trim().length > 0
    ) {
      names.push(extra);
    }
  }
  return names;
}

export function isTestLikeFile(file) {
  return TEST_FILE_PATTERN.test(file);
}

function packageHasTestFiles(dir, candidateTestFiles) {
  const prefix = `${dir}/`;
  return candidateTestFiles.some((file) => file.startsWith(prefix));
}

/**
 * "server" | "client" | ... — lane names a root package.json script actually
 * consumes via `--lane=<name>`. Read from the scripts themselves (not
 * hardcoded) so a new lane's root script wiring is what makes it "known",
 * matching the zero-edit discovery philosophy the rest of this file follows.
 */
export function extractKnownLaneNames(rootScripts) {
  const lanes = new Set();
  const pattern = /--lane[= ]([A-Za-z0-9_-]+)/g;
  for (const command of Object.values(rootScripts ?? {})) {
    if (typeof command !== "string") continue;
    for (const match of command.matchAll(pattern)) lanes.add(match[1]);
  }
  return [...lanes].sort((a, b) => a.localeCompare(b));
}

/** "absent" | "valid" | "invalid" for one package's raw testLanes value. */
export function classifyLaneDeclaration(value, knownLanes) {
  if (value === undefined) return "absent";
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) => typeof entry === "string" && knownLanes.includes(entry),
    )
  ) {
    return "valid";
  }
  return "invalid";
}

function relativeCloudRoots(repoRoot) {
  const roots = computeTestRoots(repoRoot);
  return Object.values(roots)
    .map((absolute) => normalizePath(path.relative(repoRoot, absolute)))
    .sort((a, b) => a.localeCompare(b));
}

/** Repository-tracked file paths under the given package dirs (git-owned). */
function discoverCandidateTestFiles(repoRoot, packageDirs) {
  if (packageDirs.length === 0) return [];
  const listArgs = (extra) => [
    "-C",
    repoRoot,
    "ls-files",
    "-z",
    ...extra,
    "--",
    ...packageDirs,
  ];
  const present = execFileSync(
    "git",
    listArgs(["--cached", "--others", "--exclude-standard"]),
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
  const deleted = new Set(
    execFileSync("git", listArgs(["--deleted"]), {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean),
  );
  return present
    .filter((file) => !deleted.has(file))
    .map((file) =>
      normalizeGitRepositoryPath(file, "test-lane-membership candidate"),
    );
}

function readRootScripts(repoRoot) {
  const source = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  return JSON.parse(source).scripts ?? {};
}

/**
 * Confirms this file's EXTRA_SCRIPT_NAMES copy still matches
 * run-all-tests.mjs's own array, by reading its source text rather than
 * importing the module (importing would run run-all-tests.mjs's own argv
 * parsing against THIS process's argv). Throws loudly on drift instead of
 * silently under- or over-counting which scripts make a package test-bearing.
 */
export function assertExtraScriptNamesCurrent(repoRoot) {
  const source = readFileSync(
    path.join(repoRoot, "packages", "scripts", "run-all-tests.mjs"),
    "utf8",
  );
  const match = source.match(/const EXTRA_SCRIPT_NAMES = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error(
      "could not locate EXTRA_SCRIPT_NAMES in run-all-tests.mjs; " +
        "update this audit's copy and this regex together if it was renamed or restructured",
    );
  }
  const current = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const expected = [...EXTRA_SCRIPT_NAMES];
  const drifted =
    current.length !== expected.length ||
    current.some((name, index) => name !== expected[index]);
  if (drifted) {
    throw new Error(
      `EXTRA_SCRIPT_NAMES drifted from run-all-tests.mjs: ` +
        `this file has [${expected.join(", ")}], run-all-tests.mjs has [${current.join(", ")}]. ` +
        "Update the copy in audit-test-lane-membership.mjs to match.",
    );
  }
}

function validateExclusions(
  exclusions,
  packageDirs,
  relevantDirs,
  coveredDirs,
) {
  const entries = [];
  for (const [dir, rawReason] of exclusions) {
    const reason = String(rawReason ?? "").trim();
    if (!packageDirs.has(dir)) {
      throw new Error(`exclusion path is not a workspace package: ${dir}`);
    }
    if (reason.length < 12) {
      throw new Error(`exclusion needs a durable reason: ${dir}`);
    }
    if (!relevantDirs.has(dir)) {
      throw new Error(
        `stale exclusion: ${dir} no longer has a test-shaped ` +
          "script or *.test.*/*.spec.* file — remove the exclusion",
      );
    }
    if (coveredDirs.has(dir)) {
      throw new Error(
        `stale exclusion: ${dir} is now covered by plugins/, ` +
          "a declared test lane, or a cloud bespoke root — remove the exclusion",
      );
    }
    entries.push({ dir, reason });
  }
  return entries.sort((a, b) => a.dir.localeCompare(b.dir));
}

function formatViolations(violations, knownLanes) {
  const lines = violations.map((pkg) => {
    const reasons = [];
    if (pkg.testScripts.length > 0) {
      reasons.push(`test-shaped script(s) [${pkg.testScripts.join(", ")}]`);
    }
    if (pkg.hasTestFiles && pkg.testScripts.length === 0) {
      reasons.push("*.test.*/*.spec.* file(s) with no test-shaped script");
    }
    return `  ✗ ${pkg.dir} (${pkg.name}) — ${reasons.join(" and ")}`;
  });
  const laneList =
    knownLanes.length > 0 ? knownLanes.join(", ") : "(none found)";
  return (
    `${violations.length} workspace package(s) run in no required CI lane:\n\n` +
    `${lines.join("\n")}\n\n` +
    "Each must be one of:\n" +
    "  (a) under plugins/ (covered by the tests_plugins CI job),\n" +
    `  (b) declaring elizaos.scripts.testLanes with a known lane [${laneList}],\n` +
    "  (c) inside a packages/scripts/test-cloud-run.mjs computeTestRoots() root (the bespoke cloud lane), or\n" +
    "  (d) named in TEST_LANE_MEMBERSHIP_EXCLUSIONS (packages/scripts/audit-test-lane-membership.mjs) with a durable, specific reason.\n"
  );
}

/**
 * Compute the full lane-membership report, throwing on any invalid
 * declaration, stale exclusion, or genuine violation. Every input is
 * injectable so fixtures never have to touch the real repository tree, git,
 * or test-cloud-run.mjs.
 */
export function computeTestLaneMembershipReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const packages = options.packages ?? listPackages({ repoRoot });
  const rootScripts = options.rootScripts ?? readRootScripts(repoRoot);
  const testLaneDeclarations =
    options.testLaneDeclarations ?? resolveTestLaneDeclarations({ repoRoot });
  const cloudRoots = options.cloudRoots ?? relativeCloudRoots(repoRoot);
  const exclusions = options.exclusions ?? TEST_LANE_MEMBERSHIP_EXCLUSIONS;
  const knownLanes = extractKnownLaneNames(rootScripts);
  const candidateTestFiles = (
    options.candidateFiles ??
    discoverCandidateTestFiles(
      repoRoot,
      packages.map((pkg) => pkg.dir),
    )
  )
    .map((file) =>
      normalizeGitRepositoryPath(file, "test-lane-membership candidate"),
    )
    .filter(isTestLikeFile);

  const relevant = [];
  for (const pkg of packages) {
    const testScripts = testShapedScriptNames(pkg.packageJson.scripts);
    const hasTestFiles = packageHasTestFiles(pkg.dir, candidateTestFiles);
    if (testScripts.length === 0 && !hasTestFiles) continue;

    const underPlugins = isUnderPrefix(pkg.dir, PLUGINS_DIR);
    const underCloud = cloudRoots.some((root) =>
      overlapsPackageDir(root, pkg.dir),
    );
    const laneDeclaration = testLaneDeclarations.get(pkg.dir);
    const laneValidity = classifyLaneDeclaration(laneDeclaration, knownLanes);

    relevant.push({
      dir: pkg.dir,
      name: pkg.name ?? pkg.dir,
      testScripts,
      hasTestFiles,
      underPlugins,
      underCloud,
      laneDeclaration,
      laneValidity,
    });
  }

  const invalid = relevant.filter((pkg) => pkg.laneValidity === "invalid");
  if (invalid.length > 0) {
    throw new Error(
      `${invalid.length} package(s) declare an invalid ` +
        "elizaos.scripts.testLanes (must be a non-empty array of known lanes " +
        `[${knownLanes.join(", ") || "none"}]):\n` +
        invalid
          .map(
            (pkg) => `  ✗ ${pkg.dir}: ${JSON.stringify(pkg.laneDeclaration)}`,
          )
          .join("\n"),
    );
  }

  const relevantDirs = new Set(relevant.map((pkg) => pkg.dir));
  const coveredDirs = new Set(
    relevant
      .filter(
        (pkg) =>
          pkg.underPlugins || pkg.underCloud || pkg.laneValidity === "valid",
      )
      .map((pkg) => pkg.dir),
  );

  const documentedExclusions = validateExclusions(
    exclusions,
    new Set(packages.map((pkg) => pkg.dir)),
    relevantDirs,
    coveredDirs,
  );
  const excludedDirs = new Set(documentedExclusions.map((entry) => entry.dir));

  const violations = relevant.filter(
    (pkg) => !coveredDirs.has(pkg.dir) && !excludedDirs.has(pkg.dir),
  );
  if (violations.length > 0) {
    throw new Error(formatViolations(violations, knownLanes));
  }

  // A package can legitimately satisfy more than one condition at once (e.g. a
  // plugin that also opts a `client` lane in). coveredDirs already dedupes that
  // for the pass/fail verdict; these counts apply the same (a) > (b) > (c)
  // precedence as the violation message so they partition `relevant` exactly
  // instead of double-counting an overlap in the printed summary.
  const pluginsOk = relevant.filter((pkg) => pkg.underPlugins).length;
  const laneOk = relevant.filter(
    (pkg) => !pkg.underPlugins && pkg.laneValidity === "valid",
  ).length;
  const cloudOk = relevant.filter(
    (pkg) =>
      !pkg.underPlugins && pkg.laneValidity !== "valid" && pkg.underCloud,
  ).length;

  return {
    totalPackages: packages.length,
    relevantPackages: relevant.length,
    pluginsOk,
    laneOk,
    cloudOk,
    documentedExclusions,
    knownLanes,
  };
}

function printSuccess(report) {
  const w = process.stdout.write.bind(process.stdout);
  w(
    `[audit-test-lane-membership] checked ${report.totalPackages} workspace package(s); ` +
      `${report.relevantPackages} carry a test-shaped script or test/spec file(s).\n`,
  );
  w(`  ✓ ${report.pluginsOk} under plugins/\n`);
  w(
    `  ✓ ${report.laneOk} declare a valid elizaos.scripts.testLanes (known lanes: ${report.knownLanes.join(", ")})\n`,
  );
  w(
    `  ✓ ${report.cloudOk} covered by the cloud bespoke test-cloud-run.mjs roots\n`,
  );
  w(`  ✓ ${report.documentedExclusions.length} documented exclusion(s)\n`);
  for (const entry of report.documentedExclusions) {
    w(`      - ${entry.dir}: ${entry.reason}\n`);
  }
  w(
    "[audit-test-lane-membership] ✓ every test-bearing package is accounted for\n",
  );
}

function main() {
  const repoRoot = DEFAULT_REPO_ROOT;
  assertExtraScriptNamesCurrent(repoRoot);
  const report = computeTestLaneMembershipReport({ repoRoot });
  printSuccess(report);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the executable boundary translates an incomplete or
    // invalid lane declaration into a non-zero audit result.
    process.stderr.write(
      `[audit-test-lane-membership] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
