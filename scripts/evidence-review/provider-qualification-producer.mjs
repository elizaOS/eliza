#!/usr/bin/env node
/**
 * Produces public, bundle-ready provider qualification capsules for one
 * complete 13-canary run. Private verifier inputs are staged outside the
 * repository and removed; only canonical public-key/hash-only JSON capsules
 * and their Markdown renderings are atomically published after every canary
 * qualifies and the exact catalog validates.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const CONFIG_SCHEMA = "eliza.provider-qualification-matrix-producer-config.v3";
const CATALOG_SCHEMA = "eliza.provider-qualification-catalog-config.v4";

const CANONICAL_DEFINITION_CATALOG = JSON.parse(
  fs.readFileSync(
    path.join(
      REPO_ROOT,
      "packages/scenario-runner/schema/provider-canary-definitions.json",
    ),
    "utf8",
  ),
);

export const EXPECTED_PROVIDER_SCENARIO_IDS = Object.freeze(
  CANONICAL_DEFINITION_CATALOG.scenarios.map(({ id }) => id),
);

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

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

/** Capture one immutable snapshot without following links or reopening by path. */
function captureStableFile(sourceFile, destinationFile) {
  const sourceLstat = fs.lstatSync(sourceFile, { bigint: true });
  if (
    sourceLstat.isSymbolicLink() ||
    !sourceLstat.isFile() ||
    sourceLstat.nlink !== 1n
  ) {
    throw new Error(
      `publication source is not a single-link regular file: ${sourceFile}`,
    );
  }
  const sourceDescriptor = fs.openSync(
    sourceFile,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let destinationDescriptor;
  try {
    const before = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameIdentity(sourceLstat, before)
    ) {
      throw new Error(
        `publication source changed before capture: ${sourceFile}`,
      );
    }
    destinationDescriptor = fs.openSync(
      destinationFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const bytesRead = fs.readSync(
        sourceDescriptor,
        chunk,
        0,
        chunk.length,
        null,
      );
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(
          destinationDescriptor,
          bytes,
          offset,
          bytes.length - offset,
        );
        if (written === 0)
          throw new Error(`could not stage publication: ${sourceFile}`);
        offset += written;
      }
      total += bytesRead;
    }
    fs.fsyncSync(destinationDescriptor);
    fs.closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    const after = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!sameIdentity(before, after) || BigInt(total) !== after.size) {
      throw new Error(
        `publication source changed during capture: ${sourceFile}`,
      );
    }
    return { sha256: hash.digest("hex"), size: total };
  } finally {
    if (destinationDescriptor !== undefined)
      fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
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
      "publicationFiles",
      "catalogConfigFile",
      "publicationOutputDir",
      "releaseTrustPolicyFile",
    ],
    "provider qualification producer config",
  );
  if (config.schema !== CONFIG_SCHEMA) {
    throw new Error(
      "provider qualification producer config schema is unsupported",
    );
  }
  if (
    !Array.isArray(config.publicationFiles) ||
    config.publicationFiles.length !== EXPECTED_PROVIDER_SCENARIO_IDS.length ||
    config.publicationFiles.some(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    )
  ) {
    throw new Error(
      `publicationFiles must contain exactly ${EXPECTED_PROVIDER_SCENARIO_IDS.length} non-empty paths`,
    );
  }
  const publicationFiles = config.publicationFiles.map((entry, index) =>
    resolveFrom(baseDir, entry, `publicationFiles[${index}]`),
  );
  if (new Set(publicationFiles).size !== publicationFiles.length) {
    throw new Error("publicationFiles must be unique");
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
    publicationFiles,
    catalogConfigFile: resolveFrom(
      baseDir,
      config.catalogConfigFile,
      "catalogConfigFile",
    ),
    releaseTrustPolicyFile: resolveFrom(
      baseDir,
      config.releaseTrustPolicyFile,
      "releaseTrustPolicyFile",
    ),
    publicationOutputDir,
  };
}

function absoluteCatalogConfig(
  sourceFile,
  publicationFiles,
  outputDir,
  releaseTrustPolicyFile,
) {
  const config = readJson(sourceFile, "provider qualification catalog config");
  if (config.schema !== CATALOG_SCHEMA) {
    throw new Error(`unsupported catalog config schema in ${sourceFile}`);
  }
  return { ...config, publicationFiles, outputDir, releaseTrustPolicyFile };
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function runQualificationCommand(
  mode,
  configFile,
  run,
  releaseTrustPolicyFile,
) {
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
      ...(releaseTrustPolicyFile === undefined ? [] : [releaseTrustPolicyFile]),
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
  return result;
}

function safeSlug(scenarioId) {
  return scenarioId.replace(/^provider\./u, "").replaceAll(".", "-");
}

function assertPortablePublication(publication) {
  if (publication.schema !== "eliza.provider-qualification-publication.v2") {
    throw new Error(
      "input did not contain a portable cleanup publication capsule",
    );
  }
  const artifact = plainRecord(
    publication.qualificationArtifact,
    "publication qualificationArtifact",
  );
  const scenarioId = requiredString(
    publication.scenarioId,
    "publication scenarioId",
  );
  if (artifact.scenarioId !== scenarioId) {
    throw new Error(
      `${scenarioId} publication does not match its qualification artifact`,
    );
  }
  if (artifact.schema !== "eliza.provider-qualification-artifact.v5") {
    throw new Error(`${scenarioId} did not produce a portable v5 artifact`);
  }
  const privacy = artifact.reverification?.verifierTranscript?.sourcePrivacy;
  const requiredFalse = [
    "privateProviderTargetsRetained",
    "privateKeysRetained",
    "credentialsRetained",
    "rawRunnerTranscriptRetained",
    "runDirectoryPathRetained",
  ];
  if (
    !privacy ||
    requiredFalse.some(
      (field) => !Object.hasOwn(privacy, field) || privacy[field] !== false,
    )
  ) {
    throw new Error(
      `${scenarioId} artifact does not prove its public-capsule privacy boundary`,
    );
  }
  const encoded = JSON.stringify(publication);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(encoded)) {
    throw new Error(`${scenarioId} publication contains private key material`);
  }
  return { artifact, scenarioId };
}

function verifyStagedRelease(
  stagingDir,
  qualificationRecords,
  catalogConfigFile,
  catalogDir,
  run,
  releaseTrustPolicyFile,
) {
  for (const record of qualificationRecords) {
    const publicationFile = path.join(
      stagingDir,
      record.stagingLeaf,
      "publication.json",
    );
    const verified = runQualificationCommand(
      "reverify-publication",
      publicationFile,
      run,
      releaseTrustPolicyFile,
    );
    const expectedMarkdown = requiredString(
      verified.stdout,
      `${record.scenarioId} independently reverified markdown`,
    );
    if (
      fs.readFileSync(
        path.join(stagingDir, record.stagingLeaf, "publication.md"),
        "utf8",
      ) !== expectedMarkdown
    ) {
      throw new Error(
        `${record.scenarioId} publication Markdown is not derived from staged capsule bytes`,
      );
    }
  }
  const independentCatalogDir = path.join(stagingDir, "catalog-independent");
  const independentConfig = path.join(
    stagingDir,
    "catalog-independent-config.json",
  );
  writePrivateJson(
    independentConfig,
    absoluteCatalogConfig(
      catalogConfigFile,
      qualificationRecords.map((record) =>
        path.join(stagingDir, record.stagingLeaf, "publication.json"),
      ),
      independentCatalogDir,
      releaseTrustPolicyFile,
    ),
  );
  runQualificationCommand("catalog", independentConfig, run);
  const original = readJson(
    path.join(catalogDir, "catalog.json"),
    "staged catalog",
  );
  const independent = readJson(
    path.join(independentCatalogDir, "catalog.json"),
    "independently rebuilt staged catalog",
  );
  for (const field of [
    "schema",
    "repositorySha",
    "deploymentSha",
    "scenarioCount",
    "publications",
  ]) {
    if (
      JSON.stringify(original[field]) !== JSON.stringify(independent[field])
    ) {
      throw new Error(
        `catalog ${field} changed when independently derived from staged bytes`,
      );
    }
  }
}

function publishCapsules(
  stagingDir,
  qualificationRecords,
  catalogDir,
  outputDir,
  releaseTrustPolicyFile,
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
      for (const name of ["publication.json", "publication.md"]) {
        fs.copyFileSync(
          path.join(stagingDir, record.stagingLeaf, name),
          path.join(scenarioDir, name),
          fs.constants.COPYFILE_EXCL,
        );
        fs.chmodSync(path.join(scenarioDir, name), 0o600);
      }
    }
    const catalogOutput = path.join(temporary, "catalog");
    fs.mkdirSync(catalogOutput, { mode: 0o700 });
    for (const name of ["catalog.json", "catalog.md"]) {
      fs.copyFileSync(
        path.join(catalogDir, name),
        path.join(catalogOutput, name),
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(path.join(catalogOutput, name), 0o600);
    }
    fs.copyFileSync(
      releaseTrustPolicyFile,
      path.join(temporary, "trust-policy.json"),
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(path.join(temporary, "trust-policy.json"), 0o600);
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
    const stagedReleaseTrustPolicyFile = path.join(
      stagingDir,
      "trust-policy.json",
    );
    captureStableFile(
      config.releaseTrustPolicyFile,
      stagedReleaseTrustPolicyFile,
    );
    const qualificationRecords = [];
    for (const [index, publicationFile] of config.publicationFiles.entries()) {
      const stagingLeaf = `publication-${String(index + 1).padStart(2, "0")}`;
      const outputDir = path.join(stagingDir, stagingLeaf);
      fs.mkdirSync(outputDir, { mode: 0o700 });
      const stagedPublicationFile = path.join(outputDir, "publication.json");
      captureStableFile(publicationFile, stagedPublicationFile);
      const publication = readJson(
        stagedPublicationFile,
        "provider qualification publication",
      );
      const { artifact, scenarioId } = assertPortablePublication(publication);
      if (
        artifact.decision?.qualification?.status !== "qualified" ||
        artifact.decision?.qualification?.publishable !== true
      ) {
        throw new Error(
          `${scenarioId} did not produce a publishable qualified artifact`,
        );
      }
      const verified = runQualificationCommand(
        "reverify-publication",
        stagedPublicationFile,
        run,
        stagedReleaseTrustPolicyFile,
      );
      fs.writeFileSync(
        path.join(outputDir, "publication.md"),
        requiredString(verified.stdout, `${scenarioId} reverified markdown`),
        { flag: "wx", mode: 0o600 },
      );
      qualificationRecords.push({
        scenarioId,
        publicationFile,
        stagingLeaf,
      });
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
        qualificationRecords.map((record) =>
          path.join(stagingDir, record.stagingLeaf, "publication.json"),
        ),
        catalogDir,
        stagedReleaseTrustPolicyFile,
      ),
    );
    runQualificationCommand("catalog", generatedCatalogConfig, run);
    if (!fs.existsSync(path.join(catalogDir, "catalog.md"))) {
      throw new Error(
        "provider qualification catalog did not write catalog.md",
      );
    }
    verifyStagedRelease(
      stagingDir,
      qualificationRecords,
      config.catalogConfigFile,
      catalogDir,
      run,
      stagedReleaseTrustPolicyFile,
    );
    publishCapsules(
      stagingDir,
      qualificationRecords,
      catalogDir,
      config.publicationOutputDir,
      stagedReleaseTrustPolicyFile,
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
    `[provider-qualification-producer] qualified ${result.scenarioCount} canaries; published portable evidence capsules to ${result.publicationOutputDir}\n`,
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
