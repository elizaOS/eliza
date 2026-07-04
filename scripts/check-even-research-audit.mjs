#!/usr/bin/env node
/**
 * CI gate that the Even Realities smartglasses upstream research is complete:
 * every requested reference repo is checked out under research/even-realities,
 * the upstream-audit and smartglasses docs exist, and the implemented facewear
 * surface files are present. Exits non-zero on any gap. `--self-test` exercises
 * the gate logic against synthetic inputs.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const researchRoot = "research/even-realities";
const upstreamAuditPath =
  "plugins/plugin-facewear/docs/smartglasses-upstream-audit.md";
const smartglassesDocsPath = "plugins/plugin-facewear/docs/smartglasses.md";
const requestedRepos = [
  ["fabioglimb/even-toolkit", "even-toolkit"],
  ["BxNxM/even-dev", "even-dev"],
  ["emingenc/even_glasses", "even_glasses"],
  ["binarythinktank/eveng1_python_sdk", "eveng1_python_sdk"],
  ["meyskens/fahrplan", "fahrplan"],
  ["nickustinov/weather-even-g2", "weather-even-g2"],
  ["jappyjan/even-realities", "even-realities"],
  ["emingenc/g1_flutter_blue_plus", "g1_flutter_blue_plus"],
  ["nickustinov/tesla-even-g2", "tesla-even-g2"],
  ["galfaroth/awesome-even-realities-g1", "awesome-even-realities-g1"],
  ["even-realities/EvenDemoApp", "EvenDemoApp"],
  ["Mentra-Community/MentraOS", "MentraOS"],
];
const implementedSurfacePaths = [
  "plugins/plugin-facewear/src/protocol/smartglasses.ts",
  "plugins/plugin-facewear/src/services/smartglasses-service.ts",
  "plugins/plugin-facewear/src/actions/facewear-control.ts",
  "plugins/plugin-facewear/src/providers/smartglasses-status.ts",
  "plugins/plugin-facewear/src/transport/web-bluetooth.ts",
  "plugins/plugin-facewear/src/transport/noble.ts",
  "plugins/plugin-facewear/src/transport/even-bridge.ts",
  "packages/examples/smartglasses/hardware-smoke.ts",
  "packages/examples/smartglasses/noble-hardware-smoke.ts",
  "packages/examples/smartglasses/hardware-evidence.ts",
  "packages/examples/smartglasses/evenhub-smoke.ts",
  "packages/examples/smartglasses/simulator-automation-smoke.ts",
];

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const failures = [];
const gitignore = read(".gitignore");
const audit = read(upstreamAuditPath);
const smartglassesDocs = read(smartglassesDocsPath);

failures.push(...gitignoreFailures(gitignore));
failures.push(...implementedSurfaceFailures(audit));
failures.push(...docLinkFailures(smartglassesDocs));

if (!existsSync(resolve(repoRoot, researchRoot))) {
  failures.push(`${researchRoot}: missing research root`);
}

for (const [slug, dir] of requestedRepos) {
  const relPath = `${researchRoot}/${dir}`;
  if (!existsSync(resolve(repoRoot, relPath))) {
    failures.push(`${relPath}: missing checkout for ${slug}`);
    continue;
  }
  if (!existsSync(resolve(repoRoot, relPath, ".git"))) {
    failures.push(`${relPath}: checkout for ${slug} has no .git metadata`);
  }
  failures.push(...auditRowFailures(audit, slug, relPath));
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      researchRoot,
      repositories: requestedRepos.length,
      audit: upstreamAuditPath,
    },
    null,
    2,
  ),
);

function read(relPath) {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function gitignoreFailures(source) {
  return source.includes(`${researchRoot}/`)
    ? []
    : [`.gitignore: missing ${researchRoot}/`];
}

function auditRowFailures(auditSource, slug, relPath) {
  const result = [];
  if (!auditSource.includes(`\`${slug}\``)) {
    result.push(`${upstreamAuditPath}: missing source row for ${slug}`);
  }
  if (!auditSource.includes(`\`${relPath}\``)) {
    result.push(`${upstreamAuditPath}: missing checkout path for ${relPath}`);
  }
  return result;
}

function implementedSurfaceFailures(auditSource) {
  const result = [];
  for (const relPath of implementedSurfacePaths) {
    if (!existsSync(resolve(repoRoot, relPath))) {
      result.push(`${relPath}: implemented surface path is missing`);
    }
  }
  for (const expected of [
    "src/providers/smartglasses-status.ts",
    "src/transport/even-bridge.ts",
    "src/transport/web-bluetooth.ts",
    "src/transport/noble.ts",
    "packages/examples/smartglasses/hardware-evidence.ts",
    "packages/examples/smartglasses/simulator-automation-smoke.ts",
  ]) {
    if (!auditSource.includes(expected)) {
      result.push(
        `${upstreamAuditPath}: missing implemented surface reference ${expected}`,
      );
    }
  }
  if (auditSource.includes("src/providers/status.ts")) {
    result.push(
      `${upstreamAuditPath}: stale provider path src/providers/status.ts`,
    );
  }
  return result;
}

function docLinkFailures(docsSource) {
  const result = [];
  if (!docsSource.includes("docs/smartglasses-upstream-audit.md")) {
    result.push(
      `${smartglassesDocsPath}: missing link to docs/smartglasses-upstream-audit.md`,
    );
  }
  if (docsSource.includes("docs/upstream-audit.md")) {
    result.push(
      `${smartglassesDocsPath}: stale link to docs/upstream-audit.md`,
    );
  }
  return result;
}

function runSelfTest() {
  const [slug, dir] = requestedRepos[0];
  const relPath = `${researchRoot}/${dir}`;
  const failures = [];

  const ignored = gitignoreFailures(`${researchRoot}/\n`);
  if (ignored.length > 0) failures.push(`valid gitignore failed: ${ignored}`);

  const missingIgnore = gitignoreFailures("");
  if (!missingIgnore.some((failure) => failure.includes(researchRoot))) {
    failures.push("missing gitignore fixture was not detected");
  }

  const validAudit = `| \`${slug}\` | \`${relPath}\` | files | carried |`;
  const validAuditFailures = auditRowFailures(validAudit, slug, relPath);
  if (validAuditFailures.length > 0) {
    failures.push(`valid audit row failed: ${validAuditFailures}`);
  }

  const missingSource = auditRowFailures(
    `| missing/source | \`${relPath}\` | files | carried |`,
    slug,
    relPath,
  );
  if (
    !missingSource.some((failure) => failure.includes("missing source row"))
  ) {
    failures.push("missing source row fixture was not detected");
  }

  const missingPath = auditRowFailures(
    `| \`${slug}\` | missing/path | files | carried |`,
    slug,
    relPath,
  );
  if (
    !missingPath.some((failure) => failure.includes("missing checkout path"))
  ) {
    failures.push("missing checkout path fixture was not detected");
  }

  const staleSurface = implementedSurfaceFailures("src/providers/status.ts");
  if (
    !staleSurface.some((failure) => failure.includes("stale provider path"))
  ) {
    failures.push("stale provider fixture was not detected");
  }

  const staleLink = docLinkFailures("docs/upstream-audit.md");
  if (!staleLink.some((failure) => failure.includes("stale link"))) {
    failures.push("stale doc link fixture was not detected");
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, fixtures: 6 }, null, 2));
}
