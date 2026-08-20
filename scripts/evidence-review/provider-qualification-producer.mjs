#!/usr/bin/env node
/**
 * Produces the public, bundle-ready provider qualification summaries for one
 * complete 13-canary run. Private verifier artifacts are staged outside the
 * repository, cataloged there, and removed; only hash-only Markdown is
 * atomically published beneath the canonical evidence producer root after the
 * entire inventory qualifies.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CANONICAL_OUTPUT_ROOT = path.join(
  REPO_ROOT,
  "reports",
  "provider-qualification",
);
const CONFIG_SCHEMA = "eliza.provider-qualification-matrix-producer-config.v1";
const VERIFY_SCHEMA = "eliza.provider-qualification-verify-config.v2";
const CATALOG_SCHEMA = "eliza.provider-qualification-catalog-config.v2";

export const EXPECTED_PROVIDER_SCENARIO_IDS = Object.freeze([
  "provider.bluebubbles-imessage.confirmed-send",
  "provider.discord.confirmed-send",
  "provider.duffel-travel.booking",
  "provider.gmail.confirmed-send",
  "provider.google-calendar.create",
  "provider.google-sheets.create",
  "provider.signal.confirmed-send",
  "provider.slack.confirmed-send",
  "provider.telegram.confirmed-send",
  "provider.twilio-sms.confirmed-send",
  "provider.twilio-voice.confirmed-call",
  "provider.whatsapp.confirmed-send",
  "provider.x-dm.confirmed-send",
]);

function plainRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  return value;
}

function readJson(file, label) {
  try {
    return plainRecord(JSON.parse(fs.readFileSync(file, "utf8")), label);
  } catch (error) {
    throw new Error(`failed to read ${label} from ${file}`, { cause: error });
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    throw new Error(
      `${label} violates the closed shape (expected=${wanted.join(",")}; actual=${actual.join(",")})`,
    );
  }
}

function resolveFrom(baseDir, candidate, label) {
  return path.resolve(baseDir, requiredString(candidate, label));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export function parseProviderQualificationProducerConfig(configFile) {
  const absoluteConfig = path.resolve(configFile);
  const baseDir = path.dirname(absoluteConfig);
  const config = readJson(
    absoluteConfig,
    "provider qualification producer config",
  );
  exactKeys(
    config,
    [
      "schema",
      "verifyConfigFiles",
      "catalogConfigFile",
      "publicationOutputDir",
    ],
    "provider qualification producer config",
  );
  if (config.schema !== CONFIG_SCHEMA) {
    throw new Error(
      "provider qualification producer config schema is unsupported",
    );
  }
  if (
    !Array.isArray(config.verifyConfigFiles) ||
    config.verifyConfigFiles.length !== EXPECTED_PROVIDER_SCENARIO_IDS.length ||
    config.verifyConfigFiles.some(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    )
  ) {
    throw new Error(
      `verifyConfigFiles must contain exactly ${EXPECTED_PROVIDER_SCENARIO_IDS.length} non-empty paths`,
    );
  }
  const verifyConfigFiles = config.verifyConfigFiles.map((entry, index) =>
    resolveFrom(baseDir, entry, `verifyConfigFiles[${index}]`),
  );
  if (new Set(verifyConfigFiles).size !== verifyConfigFiles.length) {
    throw new Error("verifyConfigFiles must be unique");
  }
  const publicationOutputDir = resolveFrom(
    baseDir,
    config.publicationOutputDir,
    "publicationOutputDir",
  );
  if (!isWithin(CANONICAL_OUTPUT_ROOT, publicationOutputDir)) {
    throw new Error(
      `publicationOutputDir must be a child of ${CANONICAL_OUTPUT_ROOT}`,
    );
  }
  if (fs.existsSync(publicationOutputDir)) {
    throw new Error(
      "publicationOutputDir already exists; use a new operator run id",
    );
  }
  return {
    verifyConfigFiles,
    catalogConfigFile: resolveFrom(
      baseDir,
      config.catalogConfigFile,
      "catalogConfigFile",
    ),
    publicationOutputDir,
  };
}

function absoluteVerifyConfig(sourceFile, outputDir) {
  const baseDir = path.dirname(sourceFile);
  const config = readJson(sourceFile, "provider qualification verify config");
  if (config.schema !== VERIFY_SCHEMA) {
    throw new Error(`unsupported verify config schema in ${sourceFile}`);
  }
  const scalarPaths = [
    "scenarioFile",
    "authorizationFile",
    "providerTargetFile",
    "operationInputFile",
    "failureProbesFile",
    "runDir",
    "observerEvidenceFile",
    "semanticEvidenceFile",
    "runnerReportFile",
  ];
  const listPaths = [
    "manifestAuthorityPublicKeyFiles",
    "observerPublicKeyFiles",
    "semanticJudgePublicKeyFiles",
  ];
  const materialized = { ...config, outputDir };
  for (const key of scalarPaths) {
    materialized[key] = resolveFrom(
      baseDir,
      config[key],
      `${sourceFile}:${key}`,
    );
  }
  for (const key of listPaths) {
    if (!Array.isArray(config[key]) || config[key].length === 0) {
      throw new Error(`${sourceFile}:${key} must be a non-empty path array`);
    }
    materialized[key] = config[key].map((entry, index) =>
      resolveFrom(baseDir, entry, `${sourceFile}:${key}[${index}]`),
    );
  }
  return materialized;
}

function absoluteCatalogConfig(sourceFile, artifactFiles, outputDir) {
  const config = readJson(sourceFile, "provider qualification catalog config");
  if (config.schema !== CATALOG_SCHEMA) {
    throw new Error(`unsupported catalog config schema in ${sourceFile}`);
  }
  return { ...config, artifactFiles, outputDir };
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function runQualificationCommand(mode, configFile, run) {
  const result = run(
    "bun",
    [
      "run",
      "--cwd",
      "packages/scenario-runner",
      "provider-qualification",
      "--",
      mode,
      configFile,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env } },
  );
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr ?? ""}`.trim();
    throw new Error(
      `provider qualification ${mode} failed${result.status === null ? " to start" : ` with exit ${result.status}`}${detail ? `\n${detail}` : ""}`,
      result.error ? { cause: result.error } : undefined,
    );
  }
}

function safeSlug(scenarioId) {
  return scenarioId.replace(/^provider\./u, "").replaceAll(".", "-");
}

function publishSummaries(
  stagingDir,
  qualificationRecords,
  catalogDir,
  outputDir,
) {
  const reportsRoot = path.dirname(CANONICAL_OUTPUT_ROOT);
  fs.mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(CANONICAL_OUTPUT_ROOT, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    reportsRoot,
    `.provider-qualification-${path.basename(outputDir)}.${process.pid}.tmp`,
  );
  fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const record of qualificationRecords) {
      const scenarioDir = path.join(temporary, safeSlug(record.scenarioId));
      fs.mkdirSync(scenarioDir, { mode: 0o700 });
      fs.copyFileSync(
        path.join(stagingDir, record.stagingLeaf, "qualification.md"),
        path.join(scenarioDir, "qualification.md"),
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(path.join(scenarioDir, "qualification.md"), 0o600);
    }
    const catalogOutput = path.join(temporary, "catalog");
    fs.mkdirSync(catalogOutput, { mode: 0o700 });
    fs.copyFileSync(
      path.join(catalogDir, "catalog.md"),
      path.join(catalogOutput, "catalog.md"),
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(path.join(catalogOutput, "catalog.md"), 0o600);
    fs.renameSync(temporary, outputDir);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function produceProviderQualificationSummaries(
  configFile,
  { run = spawnSync } = {},
) {
  const config = parseProviderQualificationProducerConfig(configFile);
  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-provider-qualification-"),
  );
  fs.chmodSync(stagingDir, 0o700);
  try {
    const qualificationRecords = [];
    for (const [index, sourceConfig] of config.verifyConfigFiles.entries()) {
      const stagingLeaf = `verify-${String(index + 1).padStart(2, "0")}`;
      const outputDir = path.join(stagingDir, stagingLeaf);
      const generatedConfig = path.join(stagingDir, `${stagingLeaf}.json`);
      writePrivateJson(
        generatedConfig,
        absoluteVerifyConfig(sourceConfig, outputDir),
      );
      runQualificationCommand("verify", generatedConfig, run);
      const artifactFile = path.join(outputDir, "qualification.json");
      const artifact = readJson(artifactFile, "qualification artifact");
      const scenarioId = requiredString(
        artifact.scenarioId,
        "qualification artifact scenarioId",
      );
      if (
        artifact.decision?.qualification?.status !== "qualified" ||
        artifact.decision?.qualification?.publishable !== true
      ) {
        throw new Error(
          `${scenarioId} did not produce a publishable qualified artifact`,
        );
      }
      qualificationRecords.push({ scenarioId, artifactFile, stagingLeaf });
    }

    const actualIds = qualificationRecords
      .map((record) => record.scenarioId)
      .sort();
    const expectedIds = [...EXPECTED_PROVIDER_SCENARIO_IDS].sort();
    if (
      new Set(actualIds).size !== actualIds.length ||
      actualIds.join("\n") !== expectedIds.join("\n")
    ) {
      throw new Error(
        `provider qualification inventory mismatch (expected=${expectedIds.join(",")}; actual=${actualIds.join(",")})`,
      );
    }

    const catalogDir = path.join(stagingDir, "catalog-output");
    const generatedCatalogConfig = path.join(stagingDir, "catalog-config.json");
    writePrivateJson(
      generatedCatalogConfig,
      absoluteCatalogConfig(
        config.catalogConfigFile,
        qualificationRecords.map((record) => record.artifactFile),
        catalogDir,
      ),
    );
    runQualificationCommand("catalog", generatedCatalogConfig, run);
    if (!fs.existsSync(path.join(catalogDir, "catalog.md"))) {
      throw new Error(
        "provider qualification catalog did not write catalog.md",
      );
    }
    publishSummaries(
      stagingDir,
      qualificationRecords,
      catalogDir,
      config.publicationOutputDir,
    );
    return {
      scenarioCount: qualificationRecords.length,
      publicationOutputDir: config.publicationOutputDir,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function printHelp() {
  process.stdout.write(
    "usage: node scripts/evidence-review/provider-qualification-producer.mjs <config.json>\n",
  );
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    printHelp();
    return 0;
  }
  if (argv.length !== 1) {
    printHelp();
    return 2;
  }
  const result = produceProviderQualificationSummaries(argv[0]);
  process.stdout.write(
    `[provider-qualification-producer] qualified ${result.scenarioCount} canaries; published hash-only summaries to ${result.publicationOutputDir}\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `[provider-qualification-producer] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
