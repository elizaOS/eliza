/**
 * Coordinates the canonical 13 external provider canaries without weakening
 * their one-shot execution boundary. A protected journal permits continuation
 * past already verified publication capsules while every indeterminate effect
 * stops the entire run for operator reconciliation.
 */

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
  inspectExternalCanaryRecovery,
  parseExternalProviderCanaryConfig,
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
  inspectPinnedOperatorModuleBytes,
  readStableOperatorFile,
} from "./operator-file-security.ts";
import {
  type ProviderRunReconciliationAction,
  providerRunJournalSha256,
  verifySignedProviderRunReconciliation,
} from "./provider-run-reconciliation.ts";
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
import {
  type ProviderQualificationReleaseTrustPolicy,
  validateProviderQualificationReleaseTrustPolicy,
} from "./release-trust-policy.ts";
import { parseProviderCanaryScenarioSnapshot } from "./scenario-snapshot.ts";

export const EXACT13_PROVIDER_RUN_CONFIG_SCHEMA =
  "eliza.exact13-provider-canary-run-config.v2" as const;
export const EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA =
  "eliza.exact13-provider-canary-run-journal.v2" as const;
export const PROVIDER_QUALIFICATION_MATRIX_PRODUCER_CONFIG_SCHEMA =
  "eliza.provider-qualification-matrix-producer-config.v2" as const;
export const EXACT13_PROVIDER_RUN_HELP = `Usage:
  eliza-provider-canary-exact13 <exact13-config.json>
  eliza-provider-canary-exact13 inspect <exact13-config.json>
  eliza-provider-canary-exact13 reconcile <exact13-config.json> <signed-reconciliation.json>
  eliza-provider-canary-exact13 --help

Runs the repository-owned 13 provider canaries in canonical order. Every
prepared run is preflighted before ingress. A reconciliation-required outcome
stops the set and is never retried automatically.
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
  referenceOperatorConfigFile: string;
  releaseTrustPolicyFile: string;
  catalogOutputDir: string;
  matrixHandoff?: Exact13ProviderMatrixHandoffConfig;
}

type EntryStatus =
  | "pending"
  | "running"
  | "qualified"
  | "reconciliation-required"
  | "reconciled";
type Exact13EntryPhase =
  | "pending"
  | "child-boundary-entered"
  | "child-failed"
  | "publication-verified"
  | "publication-adopted"
  | "operator-reconciled";
type Exact13EffectDisposition =
  | "no-effect"
  | "child-journal-required"
  | "ambiguous-effect"
  | "publication-recoverable"
  | "complete"
  | "operator-reconciled";

interface Exact13JournalEntry {
  scenarioId: ProviderCanaryScenarioId;
  configSha256: string;
  manifestSha256: string;
  runId: string;
  status: EntryStatus;
  phase: Exact13EntryPhase;
  effectDisposition: Exact13EffectDisposition;
  publicationSha256?: string;
}

interface Exact13RunJournal {
  schema: typeof EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA;
  planSha256: string;
  status: "active" | "complete" | "reconciliation-required" | "reconciled";
  createdAtIso: string;
  updatedAtIso: string;
  catalogCreatedAtIso?: string;
  reconciliationStatementSha256?: string;
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
  accountRefSha256: string;
  principalRefSha256: string;
  roomRefSha256: string;
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
  /** Test seam only; production callers must use the built-in offline audit. */
  inspectReadiness?: typeof import("./provider-readiness-doctor.ts").inspectExact13ProviderReadiness;
  /** Test seam only; production callers stable-read the configured policy. */
  loadReleaseTrustPolicy?: (
    file: string,
  ) => ProviderQualificationReleaseTrustPolicy;
}

function preflightBindingSha256(item: PreflightedExact13Canary): string {
  return canonicalSha256(
    canonicalJsonValue(
      {
        scenarioId: item.scenarioId,
        configFile: path.resolve(item.configFile),
        configSha256: item.configSha256,
        manifestSha256: item.manifestSha256,
        runId: item.runId,
        repositorySha: item.repositorySha,
        deploymentSha: item.deploymentSha,
        accountRefSha256: item.accountRefSha256,
        principalRefSha256: item.principalRefSha256,
        roomRefSha256: item.roomRefSha256,
        operatorStateDir: path.resolve(item.operatorStateDir),
        outputDir: path.resolve(item.outputDir),
      },
      "exact13PreflightBinding",
    ),
    "exact13PreflightBinding",
  );
}

function readinessInputSha256(
  readiness: Awaited<
    ReturnType<
      typeof import("./provider-readiness-doctor.ts").inspectExact13ProviderReadiness
    >
  >,
): string {
  return canonicalSha256(
    canonicalJsonValue(
      {
        exact13ConfigSha256: readiness.exact13ConfigSha256,
        referenceOperatorConfigSha256: readiness.referenceOperatorConfigSha256,
        releaseTrustPolicyFileSha256: readiness.releaseTrustPolicyFileSha256,
        releaseTrustPolicySha256: readiness.releaseTrustPolicySha256,
        expectedRepositorySha: readiness.expectedRepositorySha,
        canaries: readiness.canaries.map(
          ({
            scenarioId,
            preparedConfigSha256,
            manifestSha256,
            accountRefSha256,
            principalRefSha256,
            roomRefSha256,
          }) => ({
            scenarioId,
            preparedConfigSha256,
            manifestSha256,
            accountRefSha256,
            principalRefSha256,
            roomRefSha256,
          }),
        ),
      },
      "providerReadinessInput",
    ),
    "providerReadinessInput",
  );
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
      "referenceOperatorConfigFile",
      "releaseTrustPolicyFile",
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
    referenceOperatorConfigFile: nonEmptyString(
      input.referenceOperatorConfigFile,
      "referenceOperatorConfigFile",
    ),
    releaseTrustPolicyFile: nonEmptyString(
      input.releaseTrustPolicyFile,
      "releaseTrustPolicyFile",
    ),
    catalogOutputDir: nonEmptyString(
      input.catalogOutputDir,
      "catalogOutputDir",
    ),
    ...(matrixHandoff === undefined ? {} : { matrixHandoff }),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertOwnedRegularPrivateFile(file: string, label: string): Buffer {
  try {
    return readStableOperatorFile(file, label, {
      maxBytes: 16 * 1024 * 1024,
      requireCurrentUser: true,
      requirePrivateMode: true,
    });
  } catch (error) {
    // error-policy:J2 Preserve a stable public refusal while retaining cause.
    throw new Error(
      `exact-13 provider-canary coordinator ${label} is not protected`,
      { cause: error },
    );
  }
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
    const absolute = resolvePhysicalContainedPreparedFile(
      baseDir,
      candidate,
      `${label}[${index}]`,
    );
    return assertOwnedRegularPrivateFile(
      absolute,
      `${label}[${index}]`,
    ).toString("utf8");
  }) as [string, ...string[]];
}

/** Resolve both path layers and refuse a prepared-file symlink escape. */
export function resolvePhysicalContainedPreparedFile(
  parent: string,
  candidate: string,
  label: string,
): string {
  const lexical = path.resolve(parent, candidate);
  assertWithin(parent, lexical, label);
  const physical = realpathSync(lexical);
  assertWithin(parent, physical, label);
  return physical;
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
  try {
    inspectPinnedOperatorModuleBytes(operatorModuleBytes, expectedSha256);
  } catch (error) {
    fail(
      `operator module failed pinned non-executing validation: ${error instanceof Error ? error.message : "unknown refusal"}`,
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
    path.join(directory, path.basename(absoluteConfig)),
    "prepared config",
  );
  const config = parseExternalProviderCanaryConfig(
    JSON.parse(configBytes.toString("utf8")) as unknown,
  );
  const materialFile = (
    candidate: string,
    label: string,
  ): { file: string; bytes: Buffer } => {
    const file = resolvePhysicalContainedPreparedFile(
      directory,
      candidate,
      label,
    );
    return { file, bytes: assertOwnedRegularPrivateFile(file, label) };
  };
  const scenarioMaterial = materialFile(
    config.scenarioDefinitionFile,
    "scenario snapshot",
  );
  const scenario = parseProviderCanaryScenarioSnapshot({
    bytes: scenarioMaterial.bytes,
    operationKind: config.operationKind,
  });
  const parseMaterialJson = (candidate: string, label: string): unknown => {
    try {
      return JSON.parse(materialFile(candidate, label).bytes.toString("utf8"));
    } catch (error) {
      // error-policy:J2 Private values remain opaque at this boundary.
      throw new Error(`exact-13 coordinator could not read ${label}`, {
        cause: error,
      });
    }
  };
  const authorization = parseMaterialJson(
    config.authorizationFile,
    "authorization",
  );
  const providerTarget = parseMaterialJson(
    config.providerTargetFile,
    "provider target",
  );
  const operationInput = parseMaterialJson(
    config.operationInputFile,
    "operation input",
  );
  const failureProbes = parseMaterialJson(
    config.failureProbesFile,
    "failure probes",
  ) as readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  const authority = readPins(
    directory,
    config.manifestAuthorityPublicKeyFiles,
    "manifest authority pin",
  );
  const observers = readPins(
    directory,
    config.observerPublicKeyFiles,
    "observer pin",
  );
  const semantic = readPins(
    directory,
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
  try {
    inspectPinnedOperatorModuleBytes(
      operatorModule.bytes,
      config.operatorModuleSha256,
    );
  } catch (error) {
    fail(
      `operator module failed pinned non-executing validation: ${error instanceof Error ? error.message : "unknown refusal"}`,
    );
  }
  // This validates directory ownership/mode without importing the module.
  const operatorStateDir = validateProtectedOperatorStateDirectory(
    path.resolve(directory, config.operatorStateDir),
  );
  const requestedOutputDir = path.resolve(directory, config.outputDir);
  const requestedOutputParent = path.dirname(requestedOutputDir);
  const outputParent = lstatSync(requestedOutputParent);
  const physicalOutputParent = realpathSync(requestedOutputParent);
  if (
    outputParent.isSymbolicLink() ||
    !outputParent.isDirectory() ||
    (uid !== undefined && outputParent.uid !== uid) ||
    (outputParent.mode & 0o022) !== 0
  ) {
    fail("a prepared output parent is not protected");
  }
  const outputDir = path.join(
    physicalOutputParent,
    path.basename(requestedOutputDir),
  );
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
  const primary = manifest.connectors.find(
    ({ provider, accountRefSha256, connectionRefSha256 }) =>
      provider === manifest.ingress.provider &&
      accountRefSha256 === manifest.ingress.accountRefSha256 &&
      connectionRefSha256 === manifest.ingress.connectionRefSha256,
  );
  if (!primary) fail("manifest ingress connector is absent");
  return Object.freeze({
    scenarioId: scenario.id as ProviderCanaryScenarioId,
    configFile: path.join(directory, path.basename(absoluteConfig)),
    configSha256: sha256(configBytes),
    manifestSha256: manifest.manifestSha256,
    runId: manifest.run.runId,
    repositorySha: manifest.run.repositorySha,
    deploymentSha: manifest.run.deploymentSha,
    accountRefSha256: primary.accountRefSha256,
    principalRefSha256: manifest.target.principalRefSha256,
    roomRefSha256: manifest.target.roomRefSha256,
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
    ["catalogCreatedAtIso", "reconciliationStatementSha256"],
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
        [
          "scenarioId",
          "configSha256",
          "manifestSha256",
          "runId",
          "status",
          "phase",
          "effectDisposition",
        ],
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
          "reconciled",
        ].includes(String(entry.status))
      )
        fail("journal entry status is unsupported");
      if (
        ![
          "pending",
          "child-boundary-entered",
          "child-failed",
          "publication-verified",
          "publication-adopted",
          "operator-reconciled",
        ].includes(String(entry.phase)) ||
        ![
          "no-effect",
          "child-journal-required",
          "ambiguous-effect",
          "publication-recoverable",
          "complete",
          "operator-reconciled",
        ].includes(String(entry.effectDisposition))
      ) {
        fail("journal entry phase or effect disposition is unsupported");
      }
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
        phase: entry.phase as Exact13EntryPhase,
        effectDisposition: entry.effectDisposition as Exact13EffectDisposition,
        ...(entry.publicationSha256 === undefined
          ? {}
          : { publicationSha256: String(entry.publicationSha256) }),
      };
    },
  );
  if (
    !["active", "complete", "reconciliation-required", "reconciled"].includes(
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
    const validDisposition =
      (entry.status === "pending" &&
        entry.phase === "pending" &&
        entry.effectDisposition === "no-effect") ||
      (entry.status === "running" &&
        entry.phase === "child-boundary-entered" &&
        entry.effectDisposition === "child-journal-required") ||
      (entry.status === "reconciliation-required" &&
        entry.phase === "child-failed" &&
        entry.effectDisposition === "ambiguous-effect") ||
      (entry.status === "qualified" &&
        ["publication-verified", "publication-adopted"].includes(entry.phase) &&
        entry.effectDisposition === "complete") ||
      (entry.status === "reconciled" &&
        entry.phase === "operator-reconciled" &&
        entry.effectDisposition === "operator-reconciled");
    if (!validDisposition) {
      fail("journal entry status, phase, and effect disposition disagree");
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
  if (
    status === "reconciled" &&
    !entries.some((entry) => entry.status === "reconciled")
  ) {
    fail("reconciled journal lacks its operator-reconciled entry");
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
  if (
    journal.reconciliationStatementSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(String(journal.reconciliationStatementSha256))
  ) {
    fail("journal reconciliation statement digest is invalid");
  }
  return {
    schema: EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA,
    planSha256: nonEmptyString(journal.planSha256, "journal.planSha256"),
    status,
    createdAtIso,
    updatedAtIso,
    ...(catalogCreatedAtIso === undefined ? {} : { catalogCreatedAtIso }),
    ...(journal.reconciliationStatementSha256 === undefined
      ? {}
      : {
          reconciliationStatementSha256: nonEmptyString(
            journal.reconciliationStatementSha256,
            "journal.reconciliationStatementSha256",
          ),
        }),
    entries,
  };
}

function verifyPublication(
  preflight: PreflightedExact13Canary,
  readPublication: (file: string) => unknown,
  releaseTrustPolicy: ProviderQualificationReleaseTrustPolicy,
): {
  publicationSha256: string;
  value: ProviderQualificationPublicationCapsule;
} {
  const file = path.join(preflight.outputDir, "publication.json");
  const value = reverifyProviderQualificationPublication(
    readPublication(file),
    releaseTrustPolicy,
  );
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

interface Exact13RecoveryContext {
  configFile: string;
  config: Exact13ProviderRunConfig;
  plan: PreflightedExact13Canary[];
  journalFile: string;
  journal: Exact13RunJournal;
  releaseTrustPolicy: ProviderQualificationReleaseTrustPolicy;
}

export interface Exact13RecoveryDependencies {
  preflightPreparedConfig?: (
    configFile: string,
  ) => Promise<PreflightedExact13Canary>;
  loadReleaseTrustPolicy?: () => ProviderQualificationReleaseTrustPolicy;
  inspectChildRecovery?: typeof inspectExternalCanaryRecovery;
  readPublication?: (file: string) => unknown;
}

async function readExact13RecoveryContext(
  configFile: string,
  dependencies: Exact13RecoveryDependencies = {},
): Promise<Exact13RecoveryContext> {
  const absolute = path.resolve(configFile);
  const baseDir = path.dirname(absolute);
  const config = parseExact13ProviderRunConfig(
    JSON.parse(
      assertOwnedRegularPrivateFile(absolute, "coordinator config").toString(
        "utf8",
      ),
    ) as unknown,
  );
  const plan: PreflightedExact13Canary[] = [];
  const preflight =
    dependencies.preflightPreparedConfig ?? preflightExact13PreparedConfig;
  for (const candidate of config.preparedConfigFiles) {
    plan.push(await preflight(path.resolve(baseDir, candidate)));
  }
  if (
    plan.map(({ scenarioId }) => scenarioId).join("\n") !==
    PROVIDER_CANARY_SCENARIO_IDS.join("\n")
  ) {
    fail("recovery plan does not match the canonical 13-scenario order");
  }
  const stateDir = validateProtectedOperatorStateDirectory(
    path.resolve(baseDir, config.coordinatorStateDir),
  );
  const candidates: Array<{ file: string; journal: Exact13RunJournal }> = [];
  for (const name of readdirSync(stateDir)) {
    if (!name.endsWith(".journal.json")) continue;
    try {
      const journal = parseJournal(
        JSON.parse(
          assertOwnedRegularPrivateFile(
            path.join(stateDir, name),
            "coordinator journal",
          ).toString("utf8"),
        ) as unknown,
        plan,
      );
      candidates.push({ file: path.join(stateDir, name), journal });
    } catch {
      // error-policy:J3 A journal for another immutable plan is not a recovery candidate.
    }
  }
  const unresolved = candidates.filter(
    ({ journal }) => !["complete", "reconciled"].includes(journal.status),
  );
  if (unresolved.length !== 1) {
    fail("recovery requires exactly one unresolved journal for this run set");
  }
  const policy = dependencies.loadReleaseTrustPolicy
    ? dependencies.loadReleaseTrustPolicy()
    : validateProviderQualificationReleaseTrustPolicy(
        JSON.parse(
          assertOwnedRegularPrivateFile(
            path.resolve(baseDir, config.releaseTrustPolicyFile),
            "release trust policy",
          ).toString("utf8"),
        ) as unknown,
      );
  return {
    configFile: absolute,
    config,
    plan,
    journalFile: unresolved[0].file,
    journal: unresolved[0].journal,
    releaseTrustPolicy: policy,
  };
}

export interface Exact13RecoveryInspection {
  journalKind: "exact13";
  planSha256: string;
  journalSha256: string;
  status: Exact13RunJournal["status"];
  scenarioId: ProviderCanaryScenarioId;
  entryStatus: EntryStatus;
  entryPhase: Exact13EntryPhase;
  effectDisposition: Exact13EffectDisposition;
  requiredAction:
    | ProviderRunReconciliationAction
    | "recover-child-publication-first";
  childJournalSha256?: string;
  publicationSha256?: string;
}

/** Inspect an indeterminate exact-13 entry without starting a canary. */
export async function inspectExact13Recovery(
  configFile: string,
  dependencies: Exact13RecoveryDependencies = {},
): Promise<Exact13RecoveryInspection> {
  const context = await readExact13RecoveryContext(configFile, dependencies);
  const index = context.journal.entries.findIndex(({ status }) =>
    ["running", "reconciliation-required"].includes(status),
  );
  if (index < 0) {
    fail("unresolved journal has no indeterminate entry");
  }
  const entry = context.journal.entries[index];
  const item = context.plan[index];
  const childJournalFile = path.join(
    item.operatorStateDir,
    `${item.manifestSha256}.journal.json`,
  );
  let requiredAction: Exact13RecoveryInspection["requiredAction"];
  let childJournalSha256: string | undefined;
  let publicationSha256: string | undefined;
  if (!existsSync(childJournalFile)) {
    requiredAction = "abandon-proven-pre-ingress";
  } else {
    const child = (
      dependencies.inspectChildRecovery ?? inspectExternalCanaryRecovery
    )(item.configFile);
    childJournalSha256 = child.journalSha256;
    if (child.requiredAction === "recover-staged-publication") {
      requiredAction = "recover-child-publication-first";
      publicationSha256 = child.stagedPublicationSha256;
    } else if (
      child.requiredAction === "none" &&
      child.effectDisposition === "complete" &&
      existsSync(item.outputDir)
    ) {
      const verified = verifyPublication(
        item,
        dependencies.readPublication ??
          ((file) =>
            JSON.parse(
              assertOwnedRegularPrivateFile(
                file,
                "qualification publication",
              ).toString("utf8"),
            ) as unknown),
        context.releaseTrustPolicy,
      );
      requiredAction = "recover-staged-publication";
      publicationSha256 = verified.publicationSha256;
    } else if (
      child.requiredAction === "abandon-proven-pre-ingress" ||
      child.status === "abandoned"
    ) {
      requiredAction = "abandon-proven-pre-ingress";
    } else {
      requiredAction = "acknowledge-provider-reconciled";
    }
  }
  return {
    journalKind: "exact13",
    planSha256: context.journal.planSha256,
    journalSha256: providerRunJournalSha256(context.journal),
    status: context.journal.status,
    scenarioId: entry.scenarioId,
    entryStatus: entry.status,
    entryPhase: entry.phase,
    effectDisposition: entry.effectDisposition,
    requiredAction,
    ...(childJournalSha256 === undefined ? {} : { childJournalSha256 }),
    ...(publicationSha256 === undefined ? {} : { publicationSha256 }),
  };
}

/** Adopt a recovered child or close the plan using one signed statement. */
export async function reconcileExact13Recovery(input: {
  configFile: string;
  signedReconciliationFile: string;
  now?: Date;
  dependencies?: Exact13RecoveryDependencies;
}): Promise<
  | { status: "reconciled"; planSha256: string }
  | {
      status: "adopted";
      planSha256: string;
      scenarioId: ProviderCanaryScenarioId;
      publicationSha256: string;
    }
> {
  const context = await readExact13RecoveryContext(
    input.configFile,
    input.dependencies,
  );
  const inspection = await inspectExact13Recovery(
    input.configFile,
    input.dependencies,
  );
  if (inspection.requiredAction === "recover-child-publication-first") {
    fail("recover the consumed child publication before reconciling exact-13");
  }
  const statement = JSON.parse(
    assertOwnedRegularPrivateFile(
      path.resolve(input.signedReconciliationFile),
      "signed reconciliation",
    ).toString("utf8"),
  ) as unknown;
  verifySignedProviderRunReconciliation({
    value: statement,
    journal: context.journal,
    expectedJournalKind: "exact13",
    expectedTargetSha256: context.journal.planSha256,
    expectedAction: inspection.requiredAction,
    authorityPins:
      context.releaseTrustPolicy.organizations.manifestAuthority.keys,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const index = context.journal.entries.findIndex(
    ({ scenarioId }) => scenarioId === inspection.scenarioId,
  );
  const entry = context.journal.entries[index];
  if (inspection.requiredAction === "recover-staged-publication") {
    const verified = verifyPublication(
      context.plan[index],
      input.dependencies?.readPublication ??
        ((file) =>
          JSON.parse(
            assertOwnedRegularPrivateFile(
              file,
              "qualification publication",
            ).toString("utf8"),
          ) as unknown),
      context.releaseTrustPolicy,
    );
    entry.status = "qualified";
    entry.phase = "publication-adopted";
    entry.effectDisposition = "complete";
    entry.publicationSha256 = verified.publicationSha256;
    context.journal.status = "active";
  } else {
    entry.status = "reconciled";
    entry.phase = "operator-reconciled";
    entry.effectDisposition = "operator-reconciled";
    delete entry.publicationSha256;
    context.journal.status = "reconciled";
  }
  context.journal.reconciliationStatementSha256 = canonicalSha256(
    statement,
    "signedProviderRunReconciliation",
  );
  context.journal.updatedAtIso = (input.now ?? new Date()).toISOString();
  atomicWriteJson(context.journalFile, context.journal);
  if (context.journal.status === "reconciled") {
    return { status: "reconciled", planSha256: context.journal.planSha256 };
  }
  if (entry.publicationSha256 === undefined)
    fail("adopted exact-13 entry lacks a publication digest");
  return {
    status: "adopted",
    planSha256: context.journal.planSha256,
    scenarioId: entry.scenarioId,
    publicationSha256: entry.publicationSha256,
  };
}

/** Execute or safely resume the canonical exact-13 provider run. */
export async function runExact13ProviderCanaries(
  configFile: string,
  dependencies: Exact13CoordinatorDependencies = {},
): Promise<Exact13ProviderRunResult> {
  const absoluteConfig = path.resolve(configFile);
  const baseDir = path.dirname(absoluteConfig);
  let configValue: unknown;
  let configBytes: Buffer;
  try {
    configBytes = assertOwnedRegularPrivateFile(
      absoluteConfig,
      "coordinator config",
    );
    configValue = JSON.parse(configBytes.toString("utf8")) as unknown;
  } catch (error) {
    // error-policy:J2 Private config failures remain opaque to the CLI.
    throw new Error("exact-13 coordinator config is unreadable or invalid", {
      cause: error,
    });
  }
  const config = parseExact13ProviderRunConfig(configValue);
  const releaseTrustPolicyFile = path.resolve(
    baseDir,
    config.releaseTrustPolicyFile,
  );
  const referenceOperatorConfigFile = path.resolve(
    baseDir,
    config.referenceOperatorConfigFile,
  );
  const loadReleasePolicy = (): {
    policy: ProviderQualificationReleaseTrustPolicy;
    fileSha256: string;
  } => {
    if (dependencies.loadReleaseTrustPolicy) {
      const policy = dependencies.loadReleaseTrustPolicy(
        releaseTrustPolicyFile,
      );
      return { policy, fileSha256: policy.policySha256 };
    }
    const bytes = assertOwnedRegularPrivateFile(
      releaseTrustPolicyFile,
      "release trust policy",
    );
    return {
      policy: validateProviderQualificationReleaseTrustPolicy(
        JSON.parse(bytes.toString("utf8")) as unknown,
      ),
      fileSha256: sha256(bytes),
    };
  };
  const loadedReleasePolicy = loadReleasePolicy();
  const releaseTrustPolicy = loadedReleasePolicy.policy;
  const releaseTrustPolicyFileSha256 = loadedReleasePolicy.fileSha256;
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
  if (
    releaseTrustPolicy.repositorySha !== config.expectedRepositorySha ||
    releaseTrustPolicy.deploymentSha !== plan[0].deploymentSha
  ) {
    fail(
      "release trust policy does not authorize the exact repository and deployment",
    );
  }
  for (const [field, label] of [
    ["accountRefSha256", "provider account"],
    ["principalRefSha256", "authenticated principal"],
    ["roomRefSha256", "room/target"],
  ] as const) {
    if (new Set(plan.map((item) => item[field])).size !== 13) {
      fail(`each canary must use an isolated ${label} identity`);
    }
  }
  const readinessInspector =
    dependencies.inspectReadiness ??
    (await import("./provider-readiness-doctor.ts"))
      .inspectExact13ProviderReadiness;
  const readiness = await readinessInspector({
    exact13ConfigFile: absoluteConfig,
    referenceOperatorConfigFile: path.resolve(referenceOperatorConfigFile),
  });
  if (
    readiness.status !== "ready" ||
    readiness.summary.ready !== 13 ||
    readiness.summary.missing !== 0 ||
    readiness.summary.invalid !== 0 ||
    readiness.expectedRepositorySha !== config.expectedRepositorySha ||
    readiness.deploymentSha !== plan[0].deploymentSha ||
    readiness.canaries.length !== 13 ||
    readiness.canaries.map(({ scenarioId }) => scenarioId).join("\n") !==
      PROVIDER_CANARY_SCENARIO_IDS.join("\n") ||
    readiness.canaries.some(
      ({ status, checks }) =>
        status !== "ready" ||
        checks.length === 0 ||
        checks.some((item) => item.status !== "ready"),
    )
  ) {
    fail("offline readiness audit did not approve the exact bound run set");
  }
  if (
    readiness.exact13ConfigSha256 !== sha256(configBytes) ||
    readiness.referenceOperatorConfigSha256 === null ||
    readiness.referenceOperatorConfigSha256 !==
      sha256(
        assertOwnedRegularPrivateFile(
          referenceOperatorConfigFile,
          "reference operator config",
        ),
      ) ||
    readiness.releaseTrustPolicyFileSha256 !== releaseTrustPolicyFileSha256 ||
    readiness.releaseTrustPolicySha256 !== releaseTrustPolicy.policySha256 ||
    readiness.readinessInputSha256 !== readinessInputSha256(readiness)
  ) {
    fail("offline readiness audit input files changed during preflight");
  }
  const readinessByScenario = new Map(
    readiness.canaries.map((row) => [row.scenarioId, row]),
  );
  for (const item of plan) {
    const row = readinessByScenario.get(item.scenarioId);
    if (
      !row ||
      row.preparedConfigSha256 !== item.configSha256 ||
      row.manifestSha256 !== item.manifestSha256 ||
      row.accountRefSha256 !== item.accountRefSha256 ||
      row.principalRefSha256 !== item.principalRefSha256 ||
      row.roomRefSha256 !== item.roomRefSha256
    ) {
      fail("offline readiness audit is stale or belongs to a substituted plan");
    }
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
          accountRefSha256,
          principalRefSha256,
          roomRefSha256,
        }) => ({
          scenarioId,
          configSha256,
          manifestSha256,
          runId,
          repositorySha,
          deploymentSha,
          accountRefSha256,
          principalRefSha256,
          roomRefSha256,
        }),
      ),
      readinessInputSha256: readiness.readinessInputSha256,
      exact13ConfigSha256: readiness.exact13ConfigSha256,
      referenceOperatorConfigSha256: readiness.referenceOperatorConfigSha256,
      releaseTrustPolicyFileSha256,
      releaseTrustPolicySha256: releaseTrustPolicy.policySha256,
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
      for (const name of readdirSync(stateDir)) {
        if (!name.endsWith(".journal.json")) continue;
        let prior: Record<string, unknown>;
        try {
          prior = record(
            JSON.parse(
              assertOwnedRegularPrivateFile(
                path.join(stateDir, name),
                "prior coordinator journal",
              ).toString("utf8"),
            ) as unknown,
            "prior journal",
          );
        } catch (error) {
          throw new Error(
            "exact-13 coordinator contains an unreadable prior journal requiring reconciliation",
            { cause: error },
          );
        }
        if (
          prior.schema !== EXACT13_PROVIDER_RUN_JOURNAL_SCHEMA ||
          !["complete", "reconciled"].includes(String(prior.status))
        ) {
          fail(
            "an unresolved prior plan requires operator-signed reconciliation before any new run",
          );
        }
      }
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
            phase: "pending",
            effectDisposition: "no-effect",
          }),
        ),
      };
      atomicWriteJson(journalFile, journal);
    }
    if (
      journal.status === "reconciliation-required" ||
      journal.status === "reconciled" ||
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
        const verified = verifyPublication(
          plan[index],
          readPublication,
          releaseTrustPolicy,
        );
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
      if (
        sha256(
          assertOwnedRegularPrivateFile(absoluteConfig, "coordinator config"),
        ) !== readiness.exact13ConfigSha256
      ) {
        fail("coordinator config changed after readiness preflight");
      }
      if (
        sha256(
          assertOwnedRegularPrivateFile(
            referenceOperatorConfigFile,
            "reference operator config",
          ),
        ) !== readiness.referenceOperatorConfigSha256
      ) {
        fail("reference operator config changed after readiness preflight");
      }
      const currentReleasePolicy = loadReleasePolicy();
      if (
        currentReleasePolicy.fileSha256 !== releaseTrustPolicyFileSha256 ||
        currentReleasePolicy.policy.policySha256 !==
          releaseTrustPolicy.policySha256
      ) {
        fail("release trust policy changed after readiness preflight");
      }
      const currentPrepared = await preflight(plan[index].configFile);
      if (
        preflightBindingSha256(currentPrepared) !==
        preflightBindingSha256(plan[index])
      ) {
        fail("prepared canary changed after readiness preflight");
      }
      entry.status = "running";
      entry.phase = "child-boundary-entered";
      entry.effectDisposition = "child-journal-required";
      journal.updatedAtIso = now().toISOString();
      atomicWriteJson(journalFile, journal);
      try {
        const previousReferenceConfig =
          process.env.ELIZA_PROVIDER_OPERATOR_CONFIG_FILE;
        process.env.ELIZA_PROVIDER_OPERATOR_CONFIG_FILE =
          referenceOperatorConfigFile;
        let code: number;
        try {
          code = await execute(plan[index].configFile);
        } finally {
          if (previousReferenceConfig === undefined) {
            delete process.env.ELIZA_PROVIDER_OPERATOR_CONFIG_FILE;
          } else {
            process.env.ELIZA_PROVIDER_OPERATOR_CONFIG_FILE =
              previousReferenceConfig;
          }
        }
        if (code !== 0) throw new Error("external canary returned nonzero");
        const verified = verifyPublication(
          plan[index],
          readPublication,
          releaseTrustPolicy,
        );
        entry.status = "qualified";
        entry.phase = "publication-verified";
        entry.effectDisposition = "complete";
        entry.publicationSha256 = verified.publicationSha256;
        journal.updatedAtIso = now().toISOString();
        atomicWriteJson(journalFile, journal);
      } catch (error) {
        // error-policy:J2 Persist reconciliation context before rethrowing.
        entry.status = "reconciliation-required";
        entry.phase = "child-failed";
        entry.effectDisposition = "ambiguous-effect";
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
      (item) =>
        verifyPublication(item, readPublication, releaseTrustPolicy).value,
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
        releaseTrustPolicy,
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
  if (argv.length === 2 && argv[0] === "inspect") {
    process.stdout.write(
      `${JSON.stringify(await inspectExact13Recovery(argv[1]), null, 2)}\n`,
    );
    return 0;
  }
  if (argv.length === 3 && argv[0] === "reconcile") {
    process.stdout.write(
      `${JSON.stringify(
        await reconcileExact13Recovery({
          configFile: argv[1],
          signedReconciliationFile: argv[2],
        }),
        null,
        2,
      )}\n`,
    );
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
