/**
 * Coordinates the canonical 13 external provider canaries without weakening
 * their one-shot execution boundary. A protected journal permits continuation
 * past already verified publication capsules while every indeterminate effect
 * stops the entire run for operator reconciliation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_CANARY_SCENARIO_IDS,
  type ProviderCanaryScenarioId,
} from "./canary-catalog.ts";
import {
  executeExternalProviderCanaryFromConfig,
  parseExternalProviderCanaryConfig,
  readCanonicalProviderScenarioDefinition,
  validateProtectedOperatorStateDirectory,
} from "./external-canary-cli.ts";
import {
  type CanonicalJsonValue,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import type { ProviderFailureProbeMaterial } from "./operator-authorization.ts";
import { preflightAuthorizedProviderCanaryExecution } from "./operator-authorization.ts";
import {
  type ProviderQualificationPublicationCapsule,
  reverifyProviderQualificationPublication,
} from "./publication-capsule.ts";
import { normalizeProviderQualificationPublicKeyPins } from "./qualification-artifact.ts";
import {
  assembleProviderQualificationCatalog,
  type ProviderQualificationCatalog,
  renderProviderQualificationCatalogMarkdown,
} from "./qualification-catalog.ts";
import { PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA } from "./qualification-cli.ts";

export const EXACT13_PROVIDER_RUN_CONFIG_SCHEMA =
  "eliza.exact13-provider-canary-run-config.v1" as const;
export const EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA =
  "eliza.exact13-provider-canary-run-journal.v1" as const;
export const PROVIDER_QUALIFICATION_MATRIX_PRODUCER_CONFIG_SCHEMA =
  "eliza.provider-qualification-matrix-producer-config.v2" as const;
export const EXACT13_PROVIDER_RUN_HELP = `Usage:
  eliza-provider-canary-exact13 <exact13-config.json>
  eliza-provider-canary-exact13 --help

Runs the repository-owned 13 provider canaries in canonical order. Every
prepared run is preflighted before ingress. A reconciliation-required outcome
stops the set and is never retried automatically.
`;
const NON_EXECUTING_MODULE_INSPECTION = `
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(process.argv[1], "utf8");
const module = new vm.SourceTextModule(source);
await module.link(async (specifier) => {
  if (!specifier.startsWith("node:")) throw new Error("unpinned import");
  const namespace = await import(specifier);
  return new vm.SyntheticModule(Object.keys(namespace), function initialize() {
    for (const [name, value] of Object.entries(namespace)) this.setExport(name, value);
  });
});
const exports = Object.getOwnPropertyNames(module.namespace);
if (!exports.includes("createExternalProviderCanaryCapabilities")) process.exit(4);
`;

export interface Exact13ProviderMatrixHandoffConfig {
  publicationOutputDir: string;
  outputDir: string;
}

export interface Exact13ProviderRunConfig {
  schema: typeof EXACT13_PROVIDER_RUN_CONFIG_SCHEMA;
  preparedConfigFiles: readonly [string, ...string[]];
  coordinatorStateDir: string;
  expectedRepositorySha: string;
  catalogOutputDir: string;
  matrixHandoff?: Exact13ProviderMatrixHandoffConfig;
}

type EntryStatus =
  | "pending"
  | "running"
  | "qualified"
  | "reconciliation-required";

interface Exact13JournalEntry {
  scenarioId: ProviderCanaryScenarioId;
  configSha256: string;
  manifestSha256: string;
  runId: string;
  status: EntryStatus;
  publicationSha256?: string;
}

interface Exact13RunJournal {
  schema: typeof EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA;
  planSha256: string;
  status: "active" | "complete" | "reconciliation-required";
  createdAtIso: string;
  updatedAtIso: string;
  catalogCreatedAtIso?: string;
  entries: Exact13JournalEntry[];
}

export interface PreflightedExact13Canary {
  scenarioId: ProviderCanaryScenarioId;
  configFile: string;
  configSha256: string;
  manifestSha256: string;
  runId: string;
  repositorySha: string;
  deploymentSha: string;
  operatorStateDir: string;
  outputDir: string;
}

export interface Exact13ProviderRunResult {
  status: "complete" | "paused";
  planSha256: string;
  qualifiedCount: number;
  catalogOutputDir?: string;
  matrixHandoffDir?: string;
}

export interface Exact13CoordinatorDependencies {
  preflightPreparedConfig?: (
    configFile: string,
  ) => Promise<PreflightedExact13Canary>;
  executeCanary?: (configFile: string) => Promise<number>;
  readPublication?: (file: string) => unknown;
  now?: () => Date;
  signal?: AbortSignal;
}

function fail(message: string): never {
  throw new Error(`exact-13 provider-canary coordinator ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${label} violates its closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function exact13Paths(value: unknown, label: string): [string, ...string[]] {
  if (
    !Array.isArray(value) ||
    value.length !== PROVIDER_CANARY_SCENARIO_IDS.length ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    fail(`${label} must contain exactly 13 non-empty paths`);
  }
  const paths = value as [string, ...string[]];
  if (new Set(paths).size !== paths.length) fail(`${label} must be unique`);
  return paths;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  const within = (relative: string) =>
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  return within(leftToRight) || within(rightToLeft);
}

function requireDisjointDirectories(
  directories: readonly string[],
  label: string,
): void {
  for (const [index, left] of directories.entries()) {
    for (const right of directories.slice(index + 1)) {
      if (pathsOverlap(left, right)) fail(`${label} must not overlap`);
    }
  }
}

/** Parse the data-only coordinator config without reading provider material. */
export function parseExact13ProviderRunConfig(
  value: unknown,
): Exact13ProviderRunConfig {
  const input = record(value, "config");
  exactKeys(
    input,
    "config",
    [
      "schema",
      "preparedConfigFiles",
      "coordinatorStateDir",
      "expectedRepositorySha",
      "catalogOutputDir",
    ],
    ["matrixHandoff"],
  );
  if (input.schema !== EXACT13_PROVIDER_RUN_CONFIG_SCHEMA) {
    fail("config schema is unsupported");
  }
  const expectedRepositorySha = nonEmptyString(
    input.expectedRepositorySha,
    "expectedRepositorySha",
  );
  if (!/^[a-f0-9]{40}$/.test(expectedRepositorySha)) {
    fail("expectedRepositorySha must be a lowercase 40-character Git SHA");
  }
  let matrixHandoff: Exact13ProviderMatrixHandoffConfig | undefined;
  if (input.matrixHandoff !== undefined) {
    const matrix = record(input.matrixHandoff, "matrixHandoff");
    exactKeys(matrix, "matrixHandoff", ["publicationOutputDir", "outputDir"]);
    matrixHandoff = {
      publicationOutputDir: nonEmptyString(
        matrix.publicationOutputDir,
        "matrixHandoff.publicationOutputDir",
      ),
      outputDir: nonEmptyString(matrix.outputDir, "matrixHandoff.outputDir"),
    };
  }
  return Object.freeze({
    schema: EXACT13_PROVIDER_RUN_CONFIG_SCHEMA,
    preparedConfigFiles: exact13Paths(
      input.preparedConfigFiles,
      "preparedConfigFiles",
    ),
    coordinatorStateDir: nonEmptyString(
      input.coordinatorStateDir,
      "coordinatorStateDir",
    ),
    expectedRepositorySha,
    catalogOutputDir: nonEmptyString(
      input.catalogOutputDir,
      "catalogOutputDir",
    ),
    ...(matrixHandoff === undefined ? {} : { matrixHandoff }),
  });
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    // error-policy:J2 Private values remain opaque at the coordinator boundary.
    throw new Error(`exact-13 coordinator could not read ${label}`, {
      cause: error,
    });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertOwnedRegularPrivateFile(file: string, label: string): Buffer {
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    fail(`${label} must be a regular non-symlink file`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    fail(`${label} must be owned by the current POSIX user`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible to group or world`);
  }
  if (metadata.size > 16 * 1024 * 1024) {
    fail(`${label} exceeds the 16 MiB prepared-material limit`);
  }
  return readFileSync(file);
}

function assertWithin(parent: string, candidate: string, label: string): void {
  const relative = path.relative(parent, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} must remain inside its isolated prepared directory`);
  }
}

function readPins(
  baseDir: string,
  files: readonly [string, ...string[]],
  label: string,
): [string, ...string[]] {
  return files.map((candidate, index) => {
    const absolute = path.resolve(baseDir, candidate);
    assertWithin(baseDir, absolute, `${label}[${index}]`);
    return assertOwnedRegularPrivateFile(
      absolute,
      `${label}[${index}]`,
    ).toString("utf8");
  }) as [string, ...string[]];
}

function assertDisjointPinnedTrust(input: {
  authority: readonly [string, ...string[]];
  observers: readonly [string, ...string[]];
  semantic: readonly [string, ...string[]];
  authorityId: string;
  observerIds: readonly string[];
  semanticId: string;
}): void {
  const ids = (pins: readonly [string, ...string[]], label: string) =>
    new Set(
      normalizeProviderQualificationPublicKeyPins(pins, label).map(
        ({ keyId }) => keyId,
      ),
    );
  const authority = ids(input.authority, "manifest authorities");
  const observers = ids(input.observers, "provider observers");
  const semantic = ids(input.semantic, "semantic judges");
  if (!authority.has(input.authorityId))
    fail("manifest authority is not pinned");
  if (input.observerIds.some((id) => !observers.has(id))) {
    fail("a provider observer is not pinned");
  }
  if (!semantic.has(input.semanticId)) fail("semantic judge is not pinned");
  for (const id of authority) {
    if (observers.has(id) || semantic.has(id))
      fail("trust keys are not disjoint");
  }
  for (const id of observers) {
    if (semantic.has(id)) fail("trust keys are not disjoint");
  }
}

/** Parse and inspect the pinned ESM graph without evaluating operator code. */
export function validatePinnedOperatorModuleWithoutExecution(
  operatorModule: string,
  expectedSha256: string,
): void {
  const operatorModuleBytes = assertOwnedRegularPrivateFile(
    operatorModule,
    "operator module",
  );
  if (sha256(operatorModuleBytes) !== expectedSha256) {
    fail("operator module digest mismatch");
  }
  const operatorModuleText = operatorModuleBytes.toString("utf8");
  if (!Buffer.from(operatorModuleText, "utf8").equals(operatorModuleBytes)) {
    fail("operator module must be canonical UTF-8 JavaScript");
  }
  const inspection = spawnSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--input-type=module",
      "--eval",
      NON_EXECUTING_MODULE_INSPECTION,
      operatorModule,
    ],
    {
      stdio: "ignore",
      timeout: 10_000,
      env: { NODE_NO_WARNINGS: "1" },
    },
  );
  if (inspection.error || inspection.status !== 0) {
    fail(
      "operator module failed non-executing syntax/export validation or imports unpinned code",
    );
  }
}

/**
 * Verify a prepared v2 run completely, including signature, scenario snapshot,
 * key pins, and operator-module bytes, without importing operator code or
 * contacting any external system.
 */
export async function preflightExact13PreparedConfig(
  configFile: string,
): Promise<PreflightedExact13Canary> {
  const absoluteConfig = path.resolve(configFile);
  const baseDir = path.dirname(absoluteConfig);
  const directoryEntry = lstatSync(baseDir);
  const directory = realpathSync(baseDir);
  const directoryStatus = statSync(directory);
  const uid = process.getuid?.();
  if (
    directoryEntry.isSymbolicLink() ||
    !directoryStatus.isDirectory() ||
    (uid !== undefined && directoryStatus.uid !== uid) ||
    (directoryStatus.mode & 0o077) !== 0
  ) {
    fail("each prepared run directory must be real and mode 0700 or stricter");
  }
  const configBytes = assertOwnedRegularPrivateFile(
    absoluteConfig,
    "prepared config",
  );
  const config = parseExternalProviderCanaryConfig(
    JSON.parse(configBytes.toString("utf8")) as unknown,
  );
  const materialFile = (candidate: string, label: string): string => {
    const absolute = path.resolve(baseDir, candidate);
    assertWithin(baseDir, absolute, label);
    assertOwnedRegularPrivateFile(absolute, label);
    return absolute;
  };
  const scenario = readCanonicalProviderScenarioDefinition(
    materialFile(config.scenarioDefinitionFile, "scenario snapshot"),
    config.operationKind,
  );
  const authorization = readJson(
    materialFile(config.authorizationFile, "authorization"),
    "authorization",
  );
  const providerTarget = readJson(
    materialFile(config.providerTargetFile, "provider target"),
    "provider target",
  );
  const operationInput = readJson(
    materialFile(config.operationInputFile, "operation input"),
    "operation input",
  );
  const failureProbes = readJson(
    materialFile(config.failureProbesFile, "failure probes"),
    "failure probes",
  ) as readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  const authority = readPins(
    baseDir,
    config.manifestAuthorityPublicKeyFiles,
    "manifest authority pin",
  );
  const observers = readPins(
    baseDir,
    config.observerPublicKeyFiles,
    "observer pin",
  );
  const semantic = readPins(
    baseDir,
    config.semanticJudgePublicKeyFiles,
    "semantic judge pin",
  );
  const authorized = preflightAuthorizedProviderCanaryExecution({
    scenario,
    authorization: authorization as Parameters<
      typeof preflightAuthorizedProviderCanaryExecution
    >[0]["authorization"],
    pinnedManifestAuthorityPublicKeysPem: authority,
    operationKind: config.operationKind,
    providerTarget,
    operationInput,
    failureProbes,
  });
  const manifest = authorized.authorization.manifest;
  assertDisjointPinnedTrust({
    authority,
    observers,
    semantic,
    authorityId: manifest.trust.manifestAuthorityKeyId,
    observerIds: manifest.trust.observerSigners.map(({ keyId }) => keyId),
    semanticId: manifest.models.judgeKeyId,
  });
  const operatorModule = materialFile(
    config.operatorModuleFile,
    "operator module",
  );
  validatePinnedOperatorModuleWithoutExecution(
    operatorModule,
    config.operatorModuleSha256,
  );
  // This validates directory ownership/mode without importing the module.
  const operatorStateDir = validateProtectedOperatorStateDirectory(
    path.resolve(baseDir, config.operatorStateDir),
  );
  const outputDir = path.resolve(baseDir, config.outputDir);
  const outputParent = lstatSync(path.dirname(outputDir));
  if (
    outputParent.isSymbolicLink() ||
    !outputParent.isDirectory() ||
    (uid !== undefined && outputParent.uid !== uid) ||
    (outputParent.mode & 0o022) !== 0
  ) {
    fail("a prepared output parent is not protected");
  }
  const outputExists = existsSync(outputDir);
  if (outputExists) {
    const output = lstatSync(outputDir);
    if (
      output.isSymbolicLink() ||
      !output.isDirectory() ||
      (uid !== undefined && output.uid !== uid) ||
      (output.mode & 0o077) !== 0
    ) {
      fail("an existing prepared output directory is not protected");
    }
  }
  return Object.freeze({
    scenarioId: scenario.id as ProviderCanaryScenarioId,
    configFile: absoluteConfig,
    configSha256: sha256(configBytes),
    manifestSha256: manifest.manifestSha256,
    runId: manifest.run.runId,
    repositorySha: manifest.run.repositorySha,
    deploymentSha: manifest.run.deploymentSha,
    operatorStateDir,
    outputDir,
  });
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function parseJournal(
  value: unknown,
  plan: readonly PreflightedExact13Canary[],
): Exact13RunJournal {
  const journal = record(value, "journal");
  exactKeys(
    journal,
    "journal",
    [
      "schema",
      "planSha256",
      "status",
      "createdAtIso",
      "updatedAtIso",
      "entries",
    ],
    ["catalogCreatedAtIso"],
  );
  if (journal.schema !== EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA)
    fail("journal schema is unsupported");
  if (!Array.isArray(journal.entries) || journal.entries.length !== 13)
    fail("journal must contain exactly 13 entries");
  const entries = journal.entries.map(
    (candidate, index): Exact13JournalEntry => {
      const entry = record(candidate, `journal.entries[${index}]`);
      exactKeys(
        entry,
        `journal.entries[${index}]`,
        ["scenarioId", "configSha256", "manifestSha256", "runId", "status"],
        ["publicationSha256"],
      );
      const expected = plan[index];
      if (
        entry.scenarioId !== expected?.scenarioId ||
        entry.configSha256 !== expected.configSha256 ||
        entry.manifestSha256 !== expected.manifestSha256 ||
        entry.runId !== expected.runId
      )
        fail("journal plan binding does not match the preflighted run set");
      if (
        ![
          "pending",
          "running",
          "qualified",
          "reconciliation-required",
        ].includes(String(entry.status))
      )
        fail("journal entry status is unsupported");
      if (
        entry.publicationSha256 !== undefined &&
        !/^[a-f0-9]{64}$/.test(String(entry.publicationSha256))
      )
        fail("journal publication digest is invalid");
      return {
        scenarioId: expected.scenarioId,
        configSha256: expected.configSha256,
        manifestSha256: expected.manifestSha256,
        runId: expected.runId,
        status: entry.status as EntryStatus,
        ...(entry.publicationSha256 === undefined
          ? {}
          : { publicationSha256: String(entry.publicationSha256) }),
      };
    },
  );
  if (
    !["active", "complete", "reconciliation-required"].includes(
      String(journal.status),
    )
  )
    fail("journal status is unsupported");
  const status = journal.status as Exact13RunJournal["status"];
  let sawPending = false;
  for (const entry of entries) {
    if (entry.status === "pending") sawPending = true;
    if (entry.status === "qualified" && sawPending) {
      fail("journal qualification order is not a canonical prefix");
    }
    if (
      (entry.status === "qualified") !==
      (entry.publicationSha256 !== undefined)
    ) {
      fail("journal publication digest does not match entry status");
    }
  }
  if (
    status === "complete" &&
    entries.some((entry) => entry.status !== "qualified")
  ) {
    fail("complete journal must contain 13 qualified entries");
  }
  if (
    status === "reconciliation-required" &&
    !entries.some((entry) => entry.status === "reconciliation-required")
  ) {
    fail("reconciliation journal lacks its indeterminate entry");
  }
  const canonicalIso = (candidate: unknown, label: string): string => {
    const value = nonEmptyString(candidate, label);
    if (
      !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value
    ) {
      fail(`${label} must be a canonical ISO timestamp`);
    }
    return value;
  };
  const createdAtIso = canonicalIso(
    journal.createdAtIso,
    "journal.createdAtIso",
  );
  const updatedAtIso = canonicalIso(
    journal.updatedAtIso,
    "journal.updatedAtIso",
  );
  if (Date.parse(updatedAtIso) < Date.parse(createdAtIso)) {
    fail("journal chronology is invalid");
  }
  const catalogCreatedAtIso =
    journal.catalogCreatedAtIso === undefined
      ? undefined
      : canonicalIso(
          journal.catalogCreatedAtIso,
          "journal.catalogCreatedAtIso",
        );
  if (
    catalogCreatedAtIso !== undefined &&
    Date.parse(catalogCreatedAtIso) < Date.parse(createdAtIso)
  ) {
    fail("journal catalog chronology is invalid");
  }
  return {
    schema: EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA,
    planSha256: nonEmptyString(journal.planSha256, "journal.planSha256"),
    status,
    createdAtIso,
    updatedAtIso,
    ...(catalogCreatedAtIso === undefined ? {} : { catalogCreatedAtIso }),
    entries,
  };
}

function verifyPublication(
  preflight: PreflightedExact13Canary,
  readPublication: (file: string) => unknown,
): {
  publicationSha256: string;
  value: ProviderQualificationPublicationCapsule;
} {
  const file = path.join(preflight.outputDir, "publication.json");
  const value = reverifyProviderQualificationPublication(readPublication(file));
  const artifact = value.qualificationArtifact;
  if (
    value.scenarioId !== preflight.scenarioId ||
    value.runId !== preflight.runId ||
    value.manifestSha256 !== preflight.manifestSha256 ||
    !artifact.decision.qualification.publishable ||
    artifact.decision.qualification.status !== "qualified"
  )
    fail("a completed canary publication does not match its preflighted run");
  return { publicationSha256: value.publicationSha256, value };
}

function publishDirectoryAtomically(
  outputDir: string,
  write: (staging: string) => void,
): void {
  const output = path.resolve(outputDir);
  const parent = path.dirname(output);
  const parentStatus = statSync(parent);
  const uid = process.getuid?.();
  if (
    !parentStatus.isDirectory() ||
    (uid !== undefined && parentStatus.uid !== uid) ||
    (parentStatus.mode & 0o022) !== 0
  )
    fail("publication parent must be a protected directory");
  if (existsSync(output)) fail("publication output already exists");
  const staging = path.join(
    parent,
    `.${path.basename(output)}.${process.pid}.staging`,
  );
  mkdirSync(staging, { mode: 0o700 });
  try {
    write(staging);
    fsyncDirectory(staging);
    renameSync(staging, output);
    fsyncDirectory(parent);
  } catch (error) {
    // error-policy:J2 Preserve publication and teardown failures together.
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "atomic provider publication and staging cleanup failed",
      );
    }
    throw error;
  }
}

function writePrivateFile(file: string, contents: string): void {
  const descriptor = openSync(file, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertExactPublishedDirectory(
  outputDir: string,
  files: Readonly<Record<string, string>>,
): void {
  const directory = lstatSync(outputDir);
  const uid = process.getuid?.();
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    (uid !== undefined && directory.uid !== uid) ||
    (directory.mode & 0o077) !== 0
  ) {
    fail("an existing publication must be a real directory");
  }
  const actual = Object.keys(files).sort();
  const directoryEntries = readdirSync(outputDir)
    .map((name) => {
      const file = path.join(outputDir, name);
      const metadata = lstatSync(file);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (uid !== undefined && metadata.uid !== uid) ||
        (metadata.mode & 0o077) !== 0
      ) {
        fail("an existing publication contains a non-regular entry");
      }
      return name;
    })
    .sort();
  if (actual.join("\n") !== directoryEntries.join("\n")) {
    fail("an existing publication inventory changed");
  }
  for (const [name, expected] of Object.entries(files)) {
    if (readFileSync(path.join(outputDir, name), "utf8") !== expected) {
      fail("an existing publication does not match the verified run");
    }
  }
}

function ensurePublishedDirectory(
  outputDir: string,
  files: Readonly<Record<string, string>>,
): void {
  if (existsSync(outputDir)) {
    assertExactPublishedDirectory(outputDir, files);
    return;
  }
  publishDirectoryAtomically(outputDir, (staging) => {
    for (const [name, contents] of Object.entries(files)) {
      writePrivateFile(path.join(staging, name), contents);
    }
  });
}

function publishMatrixHandoff(input: {
  baseDir: string;
  handoff: Exact13ProviderMatrixHandoffConfig;
  publications: readonly PreflightedExact13Canary[];
  expectedRepositorySha: string;
}): string {
  const output = path.resolve(input.baseDir, input.handoff.outputDir);
  const catalogConfig = {
    schema: PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA,
    expectedRepositorySha: input.expectedRepositorySha,
    publicationFiles: input.publications.map(({ outputDir }) =>
      path.join(outputDir, "publication.json"),
    ),
    outputDir: path.join(output, "offline-catalog-output"),
  };
  const matrixConfig = {
    schema: PROVIDER_QUALIFICATION_MATRIX_PRODUCER_CONFIG_SCHEMA,
    publicationFiles: input.publications.map(({ outputDir }) =>
      path.join(outputDir, "publication.json"),
    ),
    catalogConfigFile: path.join(output, "catalog-config.json"),
    publicationOutputDir: path.resolve(
      input.baseDir,
      input.handoff.publicationOutputDir,
    ),
  };
  ensurePublishedDirectory(output, {
    "catalog-config.json": `${JSON.stringify(catalogConfig, null, 2)}\n`,
    "matrix-producer.json": `${JSON.stringify(matrixConfig, null, 2)}\n`,
  });
  return output;
}

/** Execute or safely resume the canonical exact-13 provider run. */
export async function runExact13ProviderCanaries(
  configFile: string,
  dependencies: Exact13CoordinatorDependencies = {},
): Promise<Exact13ProviderRunResult> {
  const absoluteConfig = path.resolve(configFile);
  const baseDir = path.dirname(absoluteConfig);
  let configValue: unknown;
  try {
    configValue = JSON.parse(
      assertOwnedRegularPrivateFile(
        absoluteConfig,
        "coordinator config",
      ).toString("utf8"),
    ) as unknown;
  } catch (error) {
    // error-policy:J2 Private config failures remain opaque to the CLI.
    throw new Error("exact-13 coordinator config is unreadable or invalid", {
      cause: error,
    });
  }
  const config = parseExact13ProviderRunConfig(configValue);
  const preflight =
    dependencies.preflightPreparedConfig ?? preflightExact13PreparedConfig;
  // Every prepared input is validated before the first provider ingress.
  const plan: PreflightedExact13Canary[] = [];
  for (const candidate of config.preparedConfigFiles)
    plan.push(await preflight(path.resolve(baseDir, candidate)));
  if (
    plan.map(({ scenarioId }) => scenarioId).join("\n") !==
    PROVIDER_CANARY_SCENARIO_IDS.join("\n")
  )
    fail("prepared configs do not match the canonical 13-scenario order");
  if (
    plan.some(
      ({ repositorySha }) => repositorySha !== config.expectedRepositorySha,
    ) ||
    new Set(plan.map(({ deploymentSha }) => deploymentSha)).size !== 1
  ) {
    fail(
      "all 13 signed manifests must bind the expected repository and one deployment revision",
    );
  }
  const preparedDirectories = plan.map(({ configFile: file }) =>
    realpathSync(path.dirname(file)),
  );
  const outputDirectories = plan.map(({ outputDir }) =>
    path.resolve(outputDir),
  );
  const stateDirectories = plan.map(({ operatorStateDir }) =>
    path.resolve(operatorStateDir),
  );
  if (
    new Set(preparedDirectories).size !== 13 ||
    new Set(outputDirectories).size !== 13 ||
    new Set(stateDirectories).size !== 13 ||
    new Set(plan.map(({ runId }) => runId)).size !== 13 ||
    new Set(plan.map(({ manifestSha256 }) => manifestSha256)).size !== 13
  ) {
    fail(
      "each canary must use isolated run, manifest, prepared, state, and output identities",
    );
  }
  requireDisjointDirectories(preparedDirectories, "prepared directories");
  requireDisjointDirectories(stateDirectories, "operator state directories");
  requireDisjointDirectories(outputDirectories, "operator output directories");
  requireDisjointDirectories(
    [...preparedDirectories, ...stateDirectories, ...outputDirectories],
    "prepared, state, and output directories",
  );
  const planCore = canonicalJsonValue(
    {
      expectedRepositorySha: config.expectedRepositorySha,
      plan: plan.map(
        ({
          scenarioId,
          configSha256,
          manifestSha256,
          runId,
          repositorySha,
          deploymentSha,
        }) => ({
          scenarioId,
          configSha256,
          manifestSha256,
          runId,
          repositorySha,
          deploymentSha,
        }),
      ),
    } as unknown as CanonicalJsonValue,
    "exact13Plan",
  );
  const planSha256 = canonicalSha256(planCore, "exact13Plan");
  const stateDir = validateProtectedOperatorStateDirectory(
    path.resolve(baseDir, config.coordinatorStateDir),
  );
  const coordinatorOutputs = [path.resolve(baseDir, config.catalogOutputDir)];
  if (config.matrixHandoff) {
    coordinatorOutputs.push(
      path.resolve(baseDir, config.matrixHandoff.outputDir),
      path.resolve(baseDir, config.matrixHandoff.publicationOutputDir),
    );
  }
  requireDisjointDirectories(
    [
      ...preparedDirectories,
      ...stateDirectories,
      ...outputDirectories,
      stateDir,
      ...coordinatorOutputs,
    ],
    "canary and coordinator directories",
  );
  const journalFile = path.join(stateDir, `${planSha256}.journal.json`);
  const lockFile = path.join(stateDir, `${planSha256}.coordinator.lock`);
  const lock = openSync(lockFile, "wx", 0o600);
  try {
    fsyncSync(lock);
    fsyncDirectory(stateDir);
    const now = dependencies.now ?? (() => new Date());
    let journal: Exact13RunJournal;
    if (existsSync(journalFile)) {
      journal = parseJournal(
        JSON.parse(
          assertOwnedRegularPrivateFile(
            journalFile,
            "coordinator journal",
          ).toString("utf8"),
        ) as unknown,
        plan,
      );
      if (journal.planSha256 !== planSha256)
        fail("journal plan digest does not match");
    } else {
      if (plan.some(({ outputDir }) => existsSync(outputDir))) {
        fail("a new exact-13 plan cannot adopt pre-existing canary output");
      }
      const createdAtIso = now().toISOString();
      journal = {
        schema: EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA,
        planSha256,
        status: "active",
        createdAtIso,
        updatedAtIso: createdAtIso,
        entries: plan.map(
          ({ scenarioId, configSha256, manifestSha256, runId }) => ({
            scenarioId,
            configSha256,
            manifestSha256,
            runId,
            status: "pending",
          }),
        ),
      };
      atomicWriteJson(journalFile, journal);
    }
    if (
      journal.status === "reconciliation-required" ||
      journal.entries.some(
        ({ status }) =>
          status === "running" || status === "reconciliation-required",
      )
    )
      fail(
        "an indeterminate provider effect requires manual reconciliation; no canary was retried",
      );
    const readPublication =
      dependencies.readPublication ??
      ((file: string) => {
        try {
          return JSON.parse(
            assertOwnedRegularPrivateFile(
              file,
              "qualification publication",
            ).toString("utf8"),
          ) as unknown;
        } catch (error) {
          // error-policy:J2 Publication path/content remains opaque to the CLI.
          throw new Error(
            "qualification publication is unreadable or invalid",
            {
              cause: error,
            },
          );
        }
      });
    for (const [index, entry] of journal.entries.entries()) {
      if (
        (entry.status === "qualified") !==
        existsSync(plan[index].outputDir)
      ) {
        fail("canary output presence does not match the protected journal");
      }
      if (entry.status === "qualified") {
        const verified = verifyPublication(plan[index], readPublication);
        if (verified.publicationSha256 !== entry.publicationSha256)
          fail("a previously qualified publication changed");
      }
    }
    if (
      journal.status === "complete" &&
      journal.entries.some(({ status }) => status !== "qualified")
    ) {
      fail("a complete journal contains an unqualified entry");
    }
    const execute =
      dependencies.executeCanary ?? executeExternalProviderCanaryFromConfig;
    for (const [index, entry] of journal.entries.entries()) {
      if (entry.status === "qualified") continue;
      if (dependencies.signal?.aborted)
        return {
          status: "paused",
          planSha256,
          qualifiedCount: journal.entries.filter(
            ({ status }) => status === "qualified",
          ).length,
        };
      entry.status = "running";
      journal.updatedAtIso = now().toISOString();
      atomicWriteJson(journalFile, journal);
      try {
        const code = await execute(plan[index].configFile);
        if (code !== 0) throw new Error("external canary returned nonzero");
        const verified = verifyPublication(plan[index], readPublication);
        entry.status = "qualified";
        entry.publicationSha256 = verified.publicationSha256;
        journal.updatedAtIso = now().toISOString();
        atomicWriteJson(journalFile, journal);
      } catch (error) {
        // error-policy:J2 Persist reconciliation context before rethrowing.
        entry.status = "reconciliation-required";
        journal.status = "reconciliation-required";
        journal.updatedAtIso = now().toISOString();
        try {
          atomicWriteJson(journalFile, journal);
        } catch (journalError) {
          // error-policy:J2 Both failures require protected-state reconciliation.
          throw new AggregateError(
            [error, journalError],
            "provider effect and coordinator journal both failed",
          );
        }
        throw error;
      }
    }
    const publicationValues = plan.map(
      (item) => verifyPublication(item, readPublication).value,
    );
    const catalogCreatedAtIso =
      journal.catalogCreatedAtIso ?? now().toISOString();
    if (
      publicationValues.some(
        ({ createdAtIso }) =>
          Date.parse(createdAtIso) > Date.parse(catalogCreatedAtIso),
      )
    ) {
      fail("catalog creation cannot predate a verified publication capsule");
    }
    journal.catalogCreatedAtIso = catalogCreatedAtIso;
    journal.updatedAtIso = now().toISOString();
    atomicWriteJson(journalFile, journal);
    const catalog: ProviderQualificationCatalog =
      assembleProviderQualificationCatalog({
        publications: publicationValues,
        expectedRepositorySha: config.expectedRepositorySha,
        createdAtIso: catalogCreatedAtIso,
      });
    const catalogOutput = path.resolve(baseDir, config.catalogOutputDir);
    ensurePublishedDirectory(catalogOutput, {
      "catalog.json": `${JSON.stringify(catalog, null, 2)}\n`,
      "catalog.md": renderProviderQualificationCatalogMarkdown(catalog),
    });
    const matrixHandoffDir = config.matrixHandoff
      ? publishMatrixHandoff({
          baseDir,
          handoff: config.matrixHandoff,
          publications: plan,
          expectedRepositorySha: config.expectedRepositorySha,
        })
      : undefined;
    journal.status = "complete";
    journal.updatedAtIso = now().toISOString();
    atomicWriteJson(journalFile, journal);
    return {
      status: "complete",
      planSha256,
      qualifiedCount: 13,
      catalogOutputDir: catalogOutput,
      ...(matrixHandoffDir === undefined ? {} : { matrixHandoffDir }),
    };
  } finally {
    closeSync(lock);
    unlinkSync(lockFile);
    fsyncDirectory(stateDir);
  }
}

/** CLI adapter with a constant fatal message that cannot expose operator data. */
export async function runExact13ProviderCanaryCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) {
    process.stdout.write(EXACT13_PROVIDER_RUN_HELP);
    return 0;
  }
  if (argv.length !== 1) {
    process.stderr.write(EXACT13_PROVIDER_RUN_HELP);
    return 2;
  }
  const result = await runExact13ProviderCanaries(argv[0]);
  process.stdout.write(
    result.status === "complete"
      ? `[eliza-provider-canary-exact13] verified ${result.qualifiedCount}/13 publication capsules and completed the catalog\n`
      : `[eliza-provider-canary-exact13] paused safely after ${result.qualifiedCount}/13 verified publication capsules\n`,
  );
  return 0;
}

export function runExact13ProviderCanaryCliAndExit(): void {
  runExact13ProviderCanaryCli()
    .then((code) => {
      process.exit(code);
    })
    // error-policy:J1 Never reflect private operator errors at the process boundary.
    .catch(() => {
      process.stderr.write(
        "[eliza-provider-canary-exact13] fatal: execution refused; inspect the protected coordinator and canary journals\n",
      );
      process.exit(1);
    });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runExact13ProviderCanaryCliAndExit();
}
