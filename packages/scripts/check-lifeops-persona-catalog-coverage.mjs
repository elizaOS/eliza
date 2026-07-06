#!/usr/bin/env node

/**
 * Coverage gate for the LifeOps persona scenario-pack ledgers. The pack
 * catalogs are progress ledgers, not executable scenarios; this script confirms
 * their declared scenario ids resolve to the real TypeScript scenario-runner
 * corpus or the Python LifeOpsBench corpus and prints authored/verified totals.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CATALOG_DIR = path.join(
  REPO_ROOT,
  "plugins/plugin-personal-assistant/test/scenarios/_catalogs",
);
const TS_SCENARIO_ROOTS = [
  "plugins/plugin-personal-assistant/test/scenarios",
  "packages/scenario-runner/test/scenarios",
].map((entry) => path.join(REPO_ROOT, entry));
const PYTHON_SCENARIO_ROOT = path.join(
  REPO_ROOT,
  "packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios",
);

const EXPECTED_CATALOGS = [
  ["adhd-capture-and-start.catalog.json", "A1", 28],
  ["adhd-follow-through.catalog.json", "A2", 24],
  ["night-owl-anchored-day.catalog.json", "B1", 24],
  ["shift-rotation.catalog.json", "B2", 22],
  ["traveler-timezone-truth.catalog.json", "C1", 28],
  ["comms-flood-triage.catalog.json", "D1", 26],
  ["low-activation-reengagement.catalog.json", "E1", 28],
  ["neurotypical-control-adversarial.catalog.json", "F1", 32],
  ["overdue-comms-apology.catalog.json", "G1", 10],
  ["reconnect-old-friends.catalog.json", "G2", 8],
  ["relationship-type-inference.catalog.json", "H1", 10],
  ["kg-live-capture.catalog.json", "H2", 8],
  ["rupture-repair.catalog.json", "I1", 10],
  ["mediation-logistics.catalog.json", "I2", 8],
  ["co-parenting.catalog.json", "J1", 10],
  ["third-party-support.catalog.json", "K1", 10],
  ["child-student-deadlines.catalog.json", "L1", 6],
];

const VALID_TIERS = new Set(["T1", "T2", "T3", "T4"]);
const VALID_SURFACES = new Set(["lifeops-bench", "scenario-runner"]);
const VALID_STATUSES = new Set(["planned", "authored", "verified"]);
const JSON_MODE = process.argv.includes("--json");

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${toPosix(path.relative(REPO_ROOT, file))}: ${error.message}`,
    );
  }
}

function walkFiles(root, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === ".turbo" ||
      entry.name === ".git"
    ) {
      continue;
    }
    const full = path.join(root, entry.name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function loadScenarioRunnerIds() {
  const ids = new Map();
  const files = TS_SCENARIO_ROOTS.flatMap((root) =>
    walkFiles(root, (file) => file.endsWith(".scenario.ts")),
  );
  const idPattern = /\bid\s*:\s*["']([^"']+)["']/;
  for (const file of files) {
    const sourceText = readFileSync(file, "utf8");
    const id = sourceText.match(idPattern)?.[1];
    if (id) ids.set(id, toPosix(path.relative(REPO_ROOT, file)));
  }
  return ids;
}

function loadLifeOpsBenchIds() {
  const ids = new Map();
  const files = walkFiles(PYTHON_SCENARIO_ROOT, (file) => file.endsWith(".py"));
  // Two id-declaration forms coexist in the bench corpus: the explicit
  // `id="..."` keyword on inline `Scenario(...)` literals, and the positional
  // first argument of the per-pack scenario factories (`_scenario(...)` /
  // `_live(...)`) some packs use to build their `SCENARIOS` list (e.g.
  // night_owl_anchored_day.py). Both resolve real, registered scenarios, so the
  // coverage gate must see both — matching only `id=` silently under-counts the
  // factory packs. `_anchor(...)`/`_definition(...)` helpers also take a leading
  // string, so the factory pattern is scoped to the scenario-builder names.
  const idKeywordPattern = /\bid\s*=\s*["']([^"']+)["']/g;
  const factoryIdPattern = /\b_(?:scenario|live)\(\s*["']([^"']+)["']/g;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(idKeywordPattern)) {
      ids.set(match[1], toPosix(path.relative(REPO_ROOT, file)));
    }
    for (const match of source.matchAll(factoryIdPattern)) {
      ids.set(match[1], toPosix(path.relative(REPO_ROOT, file)));
    }
  }
  return ids;
}

function validateCatalogShape(
  catalog,
  expectedFile,
  expectedPack,
  expectedTarget,
) {
  const where = `${expectedFile}`;
  const errors = [];
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return [`${where}: catalog must be a JSON object`];
  }
  if (typeof catalog.catalogId !== "string" || catalog.catalogId.length === 0) {
    errors.push(`${where}: catalogId must be a non-empty string`);
  }
  if (typeof catalog.title !== "string" || catalog.title.length === 0) {
    errors.push(`${where}: title must be a non-empty string`);
  }
  if (!catalog.source || typeof catalog.source !== "object") {
    errors.push(`${where}: source must be an object`);
  } else {
    if (catalog.source.packId !== expectedPack) {
      errors.push(
        `${where}: source.packId=${catalog.source.packId} expected ${expectedPack}`,
      );
    }
    if (catalog.source.targetCount !== expectedTarget) {
      errors.push(
        `${where}: source.targetCount=${catalog.source.targetCount} expected ${expectedTarget}`,
      );
    }
  }
  if (!Array.isArray(catalog.scenarios)) {
    errors.push(`${where}: scenarios must be an array`);
  }
  return errors;
}

function summarize() {
  const scenarioRunnerIds = loadScenarioRunnerIds();
  const lifeOpsBenchIds = loadLifeOpsBenchIds();
  const errors = [];
  const packs = [];

  for (const [fileName, expectedPack, expectedTarget] of EXPECTED_CATALOGS) {
    const file = path.join(CATALOG_DIR, fileName);
    const catalog = readJson(file);
    errors.push(
      ...validateCatalogShape(catalog, fileName, expectedPack, expectedTarget),
    );
    const entries = Array.isArray(catalog.scenarios) ? catalog.scenarios : [];
    let authored = 0;
    let verified = 0;
    for (const [index, entry] of entries.entries()) {
      const where = `${fileName}:scenarios[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${where}: entry must be an object`);
        continue;
      }
      const { id, tier, surface, pack, status } = entry;
      if (typeof id !== "string" || id.length === 0) {
        errors.push(`${where}: id must be a non-empty string`);
      }
      if (!VALID_TIERS.has(tier)) {
        errors.push(`${where}: tier must be one of T1, T2, T3, T4`);
      }
      if (!VALID_SURFACES.has(surface)) {
        errors.push(
          `${where}: surface must be lifeops-bench or scenario-runner`,
        );
      }
      if (pack !== expectedPack) {
        errors.push(`${where}: pack=${pack} expected ${expectedPack}`);
      }
      if (!VALID_STATUSES.has(status)) {
        errors.push(`${where}: status must be planned, authored, or verified`);
      }
      if (status === "authored" || status === "verified") {
        authored += 1;
        const idMap =
          surface === "scenario-runner" ? scenarioRunnerIds : lifeOpsBenchIds;
        if (typeof id === "string" && !idMap.has(id)) {
          errors.push(`${where}: ${surface} id "${id}" was not found`);
        }
      }
      if (status === "verified") verified += 1;
    }
    packs.push({
      file: fileName,
      pack: expectedPack,
      target: expectedTarget,
      authored,
      verified,
    });
  }

  const target = packs.reduce((sum, pack) => sum + pack.target, 0);
  const authored = packs.reduce((sum, pack) => sum + pack.authored, 0);
  const verified = packs.reduce((sum, pack) => sum + pack.verified, 0);
  return { packs, target, authored, verified, errors };
}

function main() {
  const result = summarize();
  if (JSON_MODE) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("LifeOps persona scenario catalog coverage");
    for (const pack of result.packs) {
      console.log(
        `${pack.pack.padEnd(2)} ${pack.authored}/${pack.target} authored, ${pack.verified}/${pack.authored} verified (${pack.file})`,
      );
    }
    console.log(
      `Total: ${result.authored}/${result.target} authored, ${result.verified}/${result.target} verified`,
    );
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  }
}

main();
