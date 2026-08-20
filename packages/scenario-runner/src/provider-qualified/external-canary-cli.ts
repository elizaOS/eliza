/**
 * Runs one authorization-first external provider canary from canonical data.
 * Durable manifest consumption prevents replay, and completed output appears
 * only through an atomic sibling-directory rename.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import {
  type ExternalProviderCanaryCapabilities,
  executeExternalProviderCanary,
} from "./external-canary-orchestrator.ts";
import {
  PROVIDER_OPERATION_KINDS,
  type ProviderOperationKind,
} from "./operation-binding.ts";
import {
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";
import { normalizeProviderQualificationPublicKeyPins } from "./qualification-artifact.ts";
import {
  renderProviderQualificationMarkdown,
  writeProviderQualificationOutputIntoReservedDirectory,
} from "./qualification-cli.ts";
import { parseProviderCanaryScenarioSnapshot } from "./scenario-snapshot.ts";

export const EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA =
  "eliza.external-provider-canary-config.v2" as const;
export const EXTERNAL_CANARY_MAX_SIGNATURE_AGE_MS = 300_000;
export const EXTERNAL_CANARY_MAX_CLOCK_SKEW_MS = 5_000;
export const EXTERNAL_PROVIDER_CANARY_HELP = `Usage:
  eliza-provider-canary <external-canary-config.json>
  eliza-provider-canary --help

Runs one previously authorized provider canary from canonical data and a
content-pinned operator bundle. It does not create credentials, authorization,
provider accounts, observer evidence, or judge evidence.
`;
const JOURNAL_SCHEMA = "eliza.external-provider-canary-run-journal.v1";

export interface ExternalProviderCanaryConfig {
  schema: typeof EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA;
  scenarioDefinitionFile: string;
  authorizationFile: string;
  operationKind: ProviderOperationKind;
  providerTargetFile: string;
  operationInputFile: string;
  failureProbesFile: string;
  manifestAuthorityPublicKeyFiles: readonly [string, ...string[]];
  observerPublicKeyFiles: readonly [string, ...string[]];
  semanticJudgePublicKeyFiles: readonly [string, ...string[]];
  operatorModuleFile: string;
  operatorModuleSha256: string;
  operatorStateDir: string;
  outputDir: string;
  maxSignatureAgeMs?: number;
  maxClockSkewMs?: number;
}

export interface ExternalProviderCapabilityFactoryInput {
  scenarioId: string;
  operationKind: ProviderOperationKind;
  runId: string;
  manifestSha256: string;
}

export type OperatorOwnedProviderCapabilities = Omit<
  ExternalProviderCanaryCapabilities,
  "publisher"
>;
export interface ExternalProviderCapabilityModule {
  createExternalProviderCanaryCapabilities(
    input: ExternalProviderCapabilityFactoryInput,
  ):
    | OperatorOwnedProviderCapabilities
    | Promise<OperatorOwnedProviderCapabilities>;
}
type ModuleLoader = (
  absoluteModuleFile: string,
  expectedSha256: string,
) => Promise<ExternalProviderCapabilityModule>;

export type ExternalCanaryJournalStatus =
  | "in-progress"
  | "consumed"
  | "reconciliation-required";
interface ExternalCanaryRunJournal {
  schema: typeof JOURNAL_SCHEMA;
  manifestSha256: string;
  scenarioId: string;
  runId: string;
  status: ExternalCanaryJournalStatus;
  updatedAtIso: string;
}
export interface ExternalCanaryJournalReservation {
  file: string;
  value: ExternalCanaryRunJournal;
}
export interface ExternalCanaryPublicationReservation {
  output: string;
  staging: string;
  lock: string;
  lockDescriptor: number;
}

function fail(message: string): never {
  throw new Error(`external provider-canary config ${message}`);
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

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function files(value: unknown, label: string): readonly [string, ...string[]] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    fail(`${label} must contain 1-16 non-empty file paths`);
  }
  return value as [string, ...string[]];
}

function duration(
  value: unknown,
  label: string,
  hardCap: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  if ((value as number) > hardCap) {
    fail(`${label} may only tighten the ${hardCap}ms hard cap`);
  }
  return value as number;
}

export function parseExternalProviderCanaryConfig(
  value: unknown,
): ExternalProviderCanaryConfig {
  const input = record(value, "root");
  const required = [
    "schema",
    "scenarioDefinitionFile",
    "authorizationFile",
    "operationKind",
    "providerTargetFile",
    "operationInputFile",
    "failureProbesFile",
    "manifestAuthorityPublicKeyFiles",
    "observerPublicKeyFiles",
    "semanticJudgePublicKeyFiles",
    "operatorModuleFile",
    "operatorModuleSha256",
    "operatorStateDir",
    "outputDir",
  ];
  const allowed = new Set([...required, "maxSignatureAgeMs", "maxClockSkewMs"]);
  const missing = required.filter((key) => !Object.hasOwn(input, key));
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) {
    fail(
      `violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  if (input.schema !== EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA) {
    fail("schema is unsupported");
  }
  const operationKind = string(input.operationKind, "operationKind");
  if (
    !(PROVIDER_OPERATION_KINDS as readonly string[]).includes(operationKind)
  ) {
    fail("operationKind is unsupported");
  }
  const operatorModuleSha256 = string(
    input.operatorModuleSha256,
    "operatorModuleSha256",
  );
  if (!/^[a-f0-9]{64}$/.test(operatorModuleSha256)) {
    fail("operatorModuleSha256 must be a lowercase SHA-256 digest");
  }
  const maxSignatureAgeMs = duration(
    input.maxSignatureAgeMs,
    "maxSignatureAgeMs",
    EXTERNAL_CANARY_MAX_SIGNATURE_AGE_MS,
  );
  const maxClockSkewMs = duration(
    input.maxClockSkewMs,
    "maxClockSkewMs",
    EXTERNAL_CANARY_MAX_CLOCK_SKEW_MS,
  );
  return Object.freeze({
    schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
    scenarioDefinitionFile: string(
      input.scenarioDefinitionFile,
      "scenarioDefinitionFile",
    ),
    authorizationFile: string(input.authorizationFile, "authorizationFile"),
    operationKind: operationKind as ProviderOperationKind,
    providerTargetFile: string(input.providerTargetFile, "providerTargetFile"),
    operationInputFile: string(input.operationInputFile, "operationInputFile"),
    failureProbesFile: string(input.failureProbesFile, "failureProbesFile"),
    manifestAuthorityPublicKeyFiles: files(
      input.manifestAuthorityPublicKeyFiles,
      "manifestAuthorityPublicKeyFiles",
    ),
    observerPublicKeyFiles: files(
      input.observerPublicKeyFiles,
      "observerPublicKeyFiles",
    ),
    semanticJudgePublicKeyFiles: files(
      input.semanticJudgePublicKeyFiles,
      "semanticJudgePublicKeyFiles",
    ),
    operatorModuleFile: string(input.operatorModuleFile, "operatorModuleFile"),
    operatorModuleSha256,
    operatorStateDir: string(input.operatorStateDir, "operatorStateDir"),
    outputDir: string(input.outputDir, "outputDir"),
    ...(maxSignatureAgeMs === undefined ? {} : { maxSignatureAgeMs }),
    ...(maxClockSkewMs === undefined ? {} : { maxClockSkewMs }),
  });
}

/** Read a byte-canonical, executable-free catalog scenario definition. */
export function readCanonicalProviderScenarioDefinition(
  file: string,
  operationKind: ProviderOperationKind,
): ScenarioDefinition {
  return parseProviderCanaryScenarioSnapshot({
    bytes: readFileSync(file),
    operationKind,
  });
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // error-policy:J2 Retain the input boundary without echoing private content.
    throw new Error(`failed to read ${label}`, { cause: error });
  }
}

function resolve(baseDir: string, candidate: string): string {
  return path.resolve(baseDir, candidate);
}

function readKeys(
  baseDir: string,
  paths: readonly [string, ...string[]],
): [string, ...string[]] {
  return paths.map((file) => readFileSync(resolve(baseDir, file), "utf8")) as [
    string,
    ...string[],
  ];
}

/** Require a pre-existing state directory private to the current user. */
export function validateProtectedOperatorStateDirectory(
  directory: string,
): string {
  const absolute = path.resolve(directory);
  const entry = lstatSync(absolute);
  const actual = realpathSync(absolute);
  const status = statSync(actual);
  if (entry.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(
      "external provider-canary operatorStateDir must be a real directory",
    );
  }
  if (status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) {
    throw new Error(
      "external provider-canary operatorStateDir must be current-user-owned with mode 0700 or stricter",
    );
  }
  return actual;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validateProtectedPublicationParent(directory: string): string {
  const absolute = path.resolve(directory);
  const entry = lstatSync(absolute);
  const actual = realpathSync(absolute);
  const status = statSync(actual);
  if (entry.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(
      "external provider-canary output parent must be a real directory",
    );
  }
  if (status.uid !== process.getuid?.() || (status.mode & 0o022) !== 0) {
    throw new Error(
      "external provider-canary output parent must be current-user-owned and not group/world writable",
    );
  }
  return actual;
}

function writeExclusive(file: string, value: unknown): void {
  const descriptor = openSync(file, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file));
}

/** Exclusively consume the signed manifest before operator code can run. */
export function reserveExternalCanaryRun(input: {
  operatorStateDir: string;
  manifestSha256: string;
  scenarioId: string;
  runId: string;
  now?: Date;
}): ExternalCanaryJournalReservation {
  const stateDir = validateProtectedOperatorStateDirectory(
    input.operatorStateDir,
  );
  const value: ExternalCanaryRunJournal = {
    schema: JOURNAL_SCHEMA,
    manifestSha256: input.manifestSha256,
    scenarioId: input.scenarioId,
    runId: input.runId,
    status: "in-progress",
    updatedAtIso: (input.now ?? new Date()).toISOString(),
  };
  const file = path.join(stateDir, `${input.manifestSha256}.journal.json`);
  try {
    writeExclusive(file, value);
  } catch (error) {
    if (existsSync(file)) {
      throw new Error(
        "external provider-canary manifest was already started; concurrent, crashed, consumed, and unreconciled runs cannot replay",
        { cause: error },
      );
    }
    throw error;
  }
  return { file, value };
}

/** Durably close a run as consumed or requiring manual reconciliation. */
export function transitionExternalCanaryRun(
  reservation: ExternalCanaryJournalReservation,
  status: Exclude<ExternalCanaryJournalStatus, "in-progress">,
  now = new Date(),
): void {
  const current = JSON.parse(
    readFileSync(reservation.file, "utf8"),
  ) as ExternalCanaryRunJournal;
  if (
    current.schema !== JOURNAL_SCHEMA ||
    current.manifestSha256 !== reservation.value.manifestSha256 ||
    current.status !== "in-progress"
  ) {
    throw new Error(
      "external provider-canary journal no longer matches its reservation",
    );
  }
  const temporary = `${reservation.file}.${process.pid}.tmp`;
  writeExclusive(temporary, {
    ...current,
    status,
    updatedAtIso: now.toISOString(),
  });
  renameSync(temporary, reservation.file);
  fsyncDirectory(path.dirname(reservation.file));
}

/** Fully stage output while keeping the final path absent. */
export function stageExternalCanaryDirectory(
  outputDir: string,
  manifestSha256: string,
  writeStaging: (stagingDirectory: string) => void,
): ExternalCanaryPublicationReservation {
  const requestedOutput = path.resolve(outputDir);
  const parent = validateProtectedPublicationParent(
    path.dirname(requestedOutput),
  );
  const output = path.join(parent, path.basename(requestedOutput));
  const staging = path.join(
    parent,
    `.${path.basename(output)}.${manifestSha256}.staging`,
  );
  const lock = path.join(parent, `.${path.basename(output)}.publish.lock`);
  if (existsSync(output)) {
    throw new Error("external provider-canary outputDir already exists");
  }
  const lockDescriptor = openSync(lock, "wx", 0o600);
  try {
    fsyncSync(lockDescriptor);
    fsyncDirectory(parent);
    if (existsSync(output)) {
      throw new Error("external provider-canary outputDir already exists");
    }
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    writeStaging(staging);
    fsyncDirectory(staging);
    return { output, staging, lock, lockDescriptor };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    closeSync(lockDescriptor);
    unlinkSync(lock);
    fsyncDirectory(parent);
    throw error;
  }
}

/** Discard a staged output after a pre-publication failure. */
export function abortExternalCanaryPublication(
  reservation: ExternalCanaryPublicationReservation,
): void {
  rmSync(reservation.staging, { recursive: true, force: true });
  closeSync(reservation.lockDescriptor);
  unlinkSync(reservation.lock);
  fsyncDirectory(path.dirname(reservation.output));
}

/** Expose staged output atomically; callers must first close durable state. */
export function commitExternalCanaryPublication(
  reservation: ExternalCanaryPublicationReservation,
): void {
  renameSync(reservation.staging, reservation.output);
  fsyncDirectory(path.dirname(reservation.output));
  closeSync(reservation.lockDescriptor);
  unlinkSync(reservation.lock);
  fsyncDirectory(path.dirname(reservation.output));
}

/** Testable transaction ordering: durable consumption always precedes exposure. */
export function consumeThenPublishExternalCanary(
  journal: ExternalCanaryJournalReservation,
  publication: ExternalCanaryPublicationReservation,
  transition: typeof transitionExternalCanaryRun = transitionExternalCanaryRun,
  onConsumed: () => void = () => {},
): void {
  try {
    transition(journal, "consumed");
  } catch (error) {
    abortExternalCanaryPublication(publication);
    throw error;
  }
  onConsumed();
  commitExternalCanaryPublication(publication);
}

function stageProviderQualificationOutput(
  outputDir: string,
  manifestSha256: string,
  artifact: Parameters<
    typeof writeProviderQualificationOutputIntoReservedDirectory
  >[1],
): ExternalCanaryPublicationReservation {
  return stageExternalCanaryDirectory(outputDir, manifestSha256, (staging) => {
    writeProviderQualificationOutputIntoReservedDirectory(staging, artifact);
    for (const name of ["qualification.json", "qualification.md"]) {
      const descriptor = openSync(path.join(staging, name), "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  });
}

function preflightPins(input: {
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
        (pin) => pin.keyId,
      ),
    );
  const authority = ids(input.authority, "manifestAuthorityPublicKeyFiles");
  const observers = ids(input.observers, "observerPublicKeyFiles");
  const semantic = ids(input.semantic, "semanticJudgePublicKeyFiles");
  if (!authority.has(input.authorityId))
    throw new Error("authority signer is not pinned");
  if (input.observerIds.some((id) => !observers.has(id))) {
    throw new Error("an observer signer is not pinned");
  }
  if (!semantic.has(input.semanticId))
    throw new Error("semantic signer is not pinned");
  for (const id of authority) {
    if (observers.has(id) || semantic.has(id))
      throw new Error("trust keys are not disjoint");
  }
  for (const id of observers) {
    if (semantic.has(id)) throw new Error("trust keys are not disjoint");
  }
}

/** Import exactly the reviewed operator bundle bytes. */
export async function loadPinnedExternalProviderCapabilityModule(
  absoluteModuleFile: string,
  expectedSha256: string,
): Promise<ExternalProviderCapabilityModule> {
  const bytes = readFileSync(absoluteModuleFile);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("external provider-canary operator module digest mismatch");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(
      "external provider-canary operator module must be UTF-8 JavaScript",
    );
  }
  const imported = (await import(
    `data:text/javascript;base64,${bytes.toString("base64")}`
  )) as Partial<ExternalProviderCapabilityModule>;
  if (typeof imported.createExternalProviderCanaryCapabilities !== "function") {
    throw new Error(
      "external provider-canary operator module lacks its capability factory",
    );
  }
  return imported as ExternalProviderCapabilityModule;
}

export async function executeExternalProviderCanaryFromConfig(
  configFile: string,
  dependencies: { loadOperatorModule?: ModuleLoader } = {},
): Promise<number> {
  const configPath = path.resolve(configFile);
  const baseDir = path.dirname(configPath);
  const config = parseExternalProviderCanaryConfig(
    readJson(configPath, "config"),
  );
  const scenario = readCanonicalProviderScenarioDefinition(
    resolve(baseDir, config.scenarioDefinitionFile),
    config.operationKind,
  );
  const authorization = readJson(
    resolve(baseDir, config.authorizationFile),
    "operator authorization",
  ) as ProviderCanaryAuthorization;
  const providerTarget = readJson(
    resolve(baseDir, config.providerTargetFile),
    "target",
  );
  const operationInput = readJson(
    resolve(baseDir, config.operationInputFile),
    "input",
  );
  const failureProbes = readJson(
    resolve(baseDir, config.failureProbesFile),
    "failure probes",
  ) as readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  const authority = readKeys(baseDir, config.manifestAuthorityPublicKeyFiles);
  const observers = readKeys(baseDir, config.observerPublicKeyFiles);
  const semantic = readKeys(baseDir, config.semanticJudgePublicKeyFiles);
  const preflight = preflightAuthorizedProviderCanaryExecution({
    scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: authority,
    operationKind: config.operationKind,
    providerTarget,
    operationInput,
    failureProbes,
  });
  preflightPins({
    authority,
    observers,
    semantic,
    authorityId: preflight.authorization.manifest.trust.manifestAuthorityKeyId,
    observerIds: preflight.authorization.manifest.trust.observerSigners.map(
      (item) => item.keyId,
    ),
    semanticId: preflight.authorization.manifest.models.judgeKeyId,
  });
  const reservation = reserveExternalCanaryRun({
    operatorStateDir: resolve(baseDir, config.operatorStateDir),
    manifestSha256: preflight.authorization.manifest.manifestSha256,
    scenarioId: scenario.id,
    runId: preflight.authorization.manifest.run.runId,
  });
  let publication: ExternalCanaryPublicationReservation | undefined;
  let consumed = false;
  let rendered: string;
  try {
    const module = await (
      dependencies.loadOperatorModule ??
      loadPinnedExternalProviderCapabilityModule
    )(resolve(baseDir, config.operatorModuleFile), config.operatorModuleSha256);
    const capabilities = await module.createExternalProviderCanaryCapabilities({
      scenarioId: scenario.id,
      operationKind: config.operationKind,
      runId: preflight.authorization.manifest.run.runId,
      manifestSha256: preflight.authorization.manifest.manifestSha256,
    });
    const result = await executeExternalProviderCanary({
      scenario,
      authorization,
      pinnedManifestAuthorityPublicKeysPem: authority,
      operationKind: config.operationKind,
      providerTarget,
      operationInput,
      failureProbes,
      pinnedObserverPublicKeysPem: observers,
      pinnedSemanticJudgePublicKeysPem: semantic,
      capabilities: {
        ...capabilities,
        publisher: {
          async publish(artifact) {
            publication = stageProviderQualificationOutput(
              resolve(baseDir, config.outputDir),
              preflight.authorization.manifest.manifestSha256,
              artifact,
            );
          },
        },
      },
      maxSignatureAgeMs:
        config.maxSignatureAgeMs ?? EXTERNAL_CANARY_MAX_SIGNATURE_AGE_MS,
      maxClockSkewMs:
        config.maxClockSkewMs ?? EXTERNAL_CANARY_MAX_CLOCK_SKEW_MS,
    });
    if (!publication) {
      throw new Error(
        "external provider-canary produced no staged publication",
      );
    }
    try {
      transitionExternalCanaryRun(reservation, "consumed");
    } catch (error) {
      abortExternalCanaryPublication(publication);
      publication = undefined;
      throw error;
    }
    consumed = true;
    commitExternalCanaryPublication(publication);
    publication = undefined;
    rendered = renderProviderQualificationMarkdown(result.artifact);
  } catch (error) {
    if (consumed) throw error;
    if (publication) {
      abortExternalCanaryPublication(publication);
      publication = undefined;
    }
    try {
      transitionExternalCanaryRun(reservation, "reconciliation-required");
    } catch (journalError) {
      // error-policy:J2 Both failures demand protected-state reconciliation.
      throw new AggregateError(
        [error, journalError],
        "canary and journal transition failed",
      );
    }
    throw error;
  }
  // The security transaction is complete. A stdout failure cannot mutate it.
  process.stdout.write(rendered);
  return 0;
}

export async function runExternalProviderCanaryCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) {
    process.stdout.write(EXTERNAL_PROVIDER_CANARY_HELP);
    return 0;
  }
  if (argv.length !== 1) {
    process.stderr.write(EXTERNAL_PROVIDER_CANARY_HELP);
    return 2;
  }
  return executeExternalProviderCanaryFromConfig(argv[0]);
}

/** Constant fatal text cannot reflect secrets from operator-controlled errors. */
export function renderSecretSafeExternalCanaryFatal(): string {
  return "[eliza-provider-canary] fatal: execution refused; inspect the protected operator journal for reconciliation\n";
}

export function runExternalProviderCanaryCliAndExit(): void {
  runExternalProviderCanaryCli()
    .then((code) => process.exit(code))
    // error-policy:J1 Never render an untrusted error or stack at this boundary.
    .catch(() => {
      process.stderr.write(renderSecretSafeExternalCanaryFatal());
      process.exit(1);
    });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runExternalProviderCanaryCliAndExit();
}
