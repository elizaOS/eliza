/**
 * Runs one authorization-first external provider canary from canonical data.
 * Durable manifest consumption prevents replay, and completed output appears
 * only through an atomic sibling-directory rename.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import type {
  ProviderControllerOrchestratorBridge,
  SignedProviderCleanupProof,
} from "./controller-orchestrator-bridge.ts";
import {
  type ExternalProviderCanaryCapabilities,
  executeExternalProviderCanary,
} from "./external-canary-orchestrator.ts";
import { canonicalSha256 } from "./manifest.ts";
import {
  PROVIDER_OPERATION_KINDS,
  type ProviderOperationKind,
} from "./operation-binding.ts";
import {
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";
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
  assembleProviderQualificationPublication,
  type ProviderQualificationPublicationCapsule,
  reverifyProviderQualificationPublication,
} from "./publication-capsule.ts";
import { normalizeProviderQualificationPublicKeyPins } from "./qualification-artifact.ts";
import {
  renderProviderQualificationMarkdown,
  renderProviderQualificationPublicationMarkdown,
  writeProviderQualificationPublicationIntoReservedDirectory,
} from "./qualification-cli.ts";
import {
  type ProviderQualificationReleaseTrustPolicy,
  validateProviderQualificationReleaseTrustPolicy,
} from "./release-trust-policy.ts";
import { parseProviderCanaryScenarioSnapshot } from "./scenario-snapshot.ts";

export const EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA =
  "eliza.external-provider-canary-config.v3" as const;
export const EXTERNAL_CANARY_MAX_SIGNATURE_AGE_MS = 300_000;
export const EXTERNAL_CANARY_MAX_CLOCK_SKEW_MS = 5_000;
export const EXTERNAL_PROVIDER_CANARY_HELP = `Usage:
  eliza-provider-canary <external-canary-config.json>
  eliza-provider-canary inspect <external-canary-config.json>
  eliza-provider-canary reconcile <external-canary-config.json> <signed-reconciliation.json>
  eliza-provider-canary --help

Runs one previously authorized provider canary from canonical data and a
content-pinned operator bundle. It does not create credentials, authorization,
provider accounts, observer evidence, or judge evidence.
`;
export const EXTERNAL_PROVIDER_CANARY_JOURNAL_SCHEMA =
  "eliza.external-provider-canary-run-journal.v2" as const;

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
  deploymentAttestationIssuerPublicKeyFiles: readonly [string, ...string[]];
  semanticJudgePublicKeyFiles: readonly [string, ...string[]];
  releaseTrustPolicyFile: string;
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
  repositorySha: string;
  deploymentSha: string;
}

export type OperatorOwnedProviderCapabilities = Omit<
  ExternalProviderCanaryCapabilities,
  "publisher"
>;
export interface ExternalProviderCapabilityModule {
  createExternalProviderCanaryCapabilities(
    input: ExternalProviderCapabilityFactoryInput,
  ):
    | ProviderControllerOrchestratorBridge
    | Promise<ProviderControllerOrchestratorBridge>;
}
type ModuleLoader = (
  absoluteModuleFile: string,
  expectedSha256: string,
) => Promise<ExternalProviderCapabilityModule>;

export type ExternalCanaryJournalStatus =
  | "in-progress"
  | "consumed"
  | "reconciliation-required"
  | "abandoned"
  | "reconciled"
  | "recovered";
export type ExternalCanaryJournalPhase =
  | "reserved"
  | "operator-boundary-entered"
  | "observer-started"
  | "ingress-started"
  | "ingress-completed"
  | "proofs-completed"
  | "cleanup-completed"
  | "publication-staged"
  | "manifest-consumed"
  | "publication-committed"
  | "failed";
export type ExternalCanaryEffectDisposition =
  | "proven-pre-ingress"
  | "ambiguous-effect"
  | "publication-recoverable"
  | "complete"
  | "operator-reconciled";
interface ExternalCanaryJournalTransition {
  status: ExternalCanaryJournalStatus;
  phase: ExternalCanaryJournalPhase;
  effectDisposition: ExternalCanaryEffectDisposition;
  atIso: string;
}
export interface ExternalCanaryRunJournal {
  schema: typeof EXTERNAL_PROVIDER_CANARY_JOURNAL_SCHEMA;
  manifestSha256: string;
  scenarioId: string;
  runId: string;
  status: ExternalCanaryJournalStatus;
  phase: ExternalCanaryJournalPhase;
  effectDisposition: ExternalCanaryEffectDisposition;
  publicationSha256?: string;
  reconciliationStatementSha256?: string;
  updatedAtIso: string;
  transitions: readonly [
    ExternalCanaryJournalTransition,
    ...ExternalCanaryJournalTransition[],
  ];
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

function exactDataFunctionObject(
  value: unknown,
  label: string,
  functionName: string,
): void {
  const object = record(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (
    Object.keys(descriptors).length !== 1 ||
    !Object.hasOwn(descriptors, functionName)
  ) {
    fail(`${label} must contain only ${functionName}`);
  }
  const descriptor = descriptors[functionName];
  if (
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    descriptor.enumerable !== true
  ) {
    fail(`${label}.${functionName} must be an enumerable data function`);
  }
}

/** Reject accessors and unexpected capability surfaces without invoking them. */
export function validateOperatorOwnedProviderCapabilities(
  value: unknown,
): OperatorOwnedProviderCapabilities {
  const capabilities = record(value, "operator capabilities");
  const expected = {
    observer: "begin",
    ingress: "execute",
    trajectories: "verify",
    semanticJudge: "judge",
    cleanup: "cleanup",
  } as const;
  const descriptors = Object.getOwnPropertyDescriptors(capabilities);
  const missing = Object.keys(expected).filter(
    (key) => !Object.hasOwn(descriptors, key),
  );
  const unknown = Object.keys(descriptors).filter(
    (key) => !Object.hasOwn(expected, key),
  );
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `operator capabilities violate the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  for (const [key, functionName] of Object.entries(expected)) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`operator capabilities.${key} must be an enumerable data property`);
    }
    exactDataFunctionObject(
      descriptor.value,
      `operator capabilities.${key}`,
      functionName,
    );
  }
  return capabilities as unknown as OperatorOwnedProviderCapabilities;
}

/** Require the bridge wrapper that carries one consumable signed cleanup proof. */
export function validateExternalProviderCapabilityBundle(
  value: unknown,
): ProviderControllerOrchestratorBridge {
  const bundle = record(value, "operator capability bundle");
  const descriptors = Object.getOwnPropertyDescriptors(bundle);
  const expected = [
    "capabilities",
    "cleanupPublicKeyPem",
    "takeVerifiedCleanupProof",
  ] as const;
  const missing = expected.filter((key) => !Object.hasOwn(descriptors, key));
  const unknown = Object.keys(descriptors).filter(
    (key) => !expected.includes(key as (typeof expected)[number]),
  );
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `operator capability bundle violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      fail(
        `operator capability bundle.${key} must be an enumerable data property`,
      );
    }
  }
  if (
    typeof descriptors.cleanupPublicKeyPem.value !== "string" ||
    descriptors.cleanupPublicKeyPem.value.includes("PRIVATE KEY")
  ) {
    fail("operator capability bundle.cleanupPublicKeyPem must be a public PEM");
  }
  if (typeof descriptors.takeVerifiedCleanupProof.value !== "function") {
    fail(
      "operator capability bundle.takeVerifiedCleanupProof must be a data function",
    );
  }
  return {
    capabilities: validateOperatorOwnedProviderCapabilities(
      descriptors.capabilities.value,
    ),
    cleanupPublicKeyPem: descriptors.cleanupPublicKeyPem.value,
    takeVerifiedCleanupProof: descriptors.takeVerifiedCleanupProof.value.bind(
      bundle,
    ) as () => SignedProviderCleanupProof,
  };
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
    "deploymentAttestationIssuerPublicKeyFiles",
    "semanticJudgePublicKeyFiles",
    "releaseTrustPolicyFile",
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
    deploymentAttestationIssuerPublicKeyFiles: files(
      input.deploymentAttestationIssuerPublicKeyFiles,
      "deploymentAttestationIssuerPublicKeyFiles",
    ),
    semanticJudgePublicKeyFiles: files(
      input.semanticJudgePublicKeyFiles,
      "semanticJudgePublicKeyFiles",
    ),
    releaseTrustPolicyFile: string(
      input.releaseTrustPolicyFile,
      "releaseTrustPolicyFile",
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
    bytes: readStableOperatorFile(file, "scenario definition"),
    operationKind,
  });
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readStableOperatorFile(file, label).toString("utf8"));
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
  return paths.map((file) =>
    readStableOperatorFile(resolve(baseDir, file), "public-key pin").toString(
      "utf8",
    ),
  ) as [string, ...string[]];
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

function isUnresolvedExternalJournal(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return true;
  const journal = value as Record<string, unknown>;
  if (journal.schema !== EXTERNAL_PROVIDER_CANARY_JOURNAL_SCHEMA) return true;
  return !["abandoned", "reconciled", "recovered", "consumed"].includes(
    String(journal.status),
  );
}

function refuseUnresolvedExternalJournals(stateDir: string): void {
  for (const name of readdirSync(stateDir)) {
    if (!name.endsWith(".journal.json")) continue;
    let value: unknown;
    try {
      value = JSON.parse(
        readStableOperatorFile(
          path.join(stateDir, name),
          "operator journal",
        ).toString("utf8"),
      ) as unknown;
    } catch (error) {
      throw new Error(
        "external provider-canary state contains an unreadable journal requiring reconciliation",
        { cause: error },
      );
    }
    if (isUnresolvedExternalJournal(value)) {
      throw new Error(
        "external provider-canary cannot replay while state contains an unresolved prior run; an operator-signed reconciliation is required before any new run",
      );
    }
  }
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
  refuseUnresolvedExternalJournals(stateDir);
  const atIso = (input.now ?? new Date()).toISOString();
  const initial: ExternalCanaryJournalTransition = {
    status: "in-progress",
    phase: "reserved",
    effectDisposition: "proven-pre-ingress",
    atIso,
  };
  const value: ExternalCanaryRunJournal = {
    schema: EXTERNAL_PROVIDER_CANARY_JOURNAL_SCHEMA,
    manifestSha256: input.manifestSha256,
    scenarioId: input.scenarioId,
    runId: input.runId,
    status: "in-progress",
    phase: "reserved",
    effectDisposition: "proven-pre-ingress",
    updatedAtIso: atIso,
    transitions: [initial],
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
  transitionExternalCanaryJournal(reservation, {
    status,
    phase: status === "consumed" ? "manifest-consumed" : "failed",
    effectDisposition:
      status === "consumed" ? "publication-recoverable" : "ambiguous-effect",
    now,
  });
}

/** Durably record stage and effect disposition without erasing prior states. */
export function transitionExternalCanaryJournal(
  reservation: ExternalCanaryJournalReservation,
  input: {
    status?: ExternalCanaryJournalStatus;
    phase: ExternalCanaryJournalPhase;
    effectDisposition: ExternalCanaryEffectDisposition;
    publicationSha256?: string;
    reconciliationStatementSha256?: string;
    now?: Date;
  },
): ExternalCanaryRunJournal {
  const current = JSON.parse(
    readStableOperatorFile(reservation.file, "operator journal").toString(
      "utf8",
    ),
  ) as ExternalCanaryRunJournal;
  if (
    current.schema !== EXTERNAL_PROVIDER_CANARY_JOURNAL_SCHEMA ||
    current.manifestSha256 !== reservation.value.manifestSha256
  ) {
    throw new Error(
      "external provider-canary journal no longer matches its reservation",
    );
  }
  const status = input.status ?? current.status;
  const atIso = (input.now ?? new Date()).toISOString();
  const next: ExternalCanaryRunJournal = {
    ...current,
    status,
    phase: input.phase,
    effectDisposition: input.effectDisposition,
    ...(input.publicationSha256 === undefined
      ? current.publicationSha256 === undefined
        ? {}
        : { publicationSha256: current.publicationSha256 }
      : { publicationSha256: input.publicationSha256 }),
    ...(input.reconciliationStatementSha256 === undefined
      ? current.reconciliationStatementSha256 === undefined
        ? {}
        : {
            reconciliationStatementSha256:
              current.reconciliationStatementSha256,
          }
      : {
          reconciliationStatementSha256: input.reconciliationStatementSha256,
        }),
    updatedAtIso: atIso,
    transitions: [
      ...current.transitions,
      {
        status,
        phase: input.phase,
        effectDisposition: input.effectDisposition,
        atIso,
      },
    ],
  };
  const temporary = `${reservation.file}.${process.pid}.tmp`;
  writeExclusive(temporary, next);
  renameSync(temporary, reservation.file);
  fsyncDirectory(path.dirname(reservation.file));
  reservation.value = next;
  return next;
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
  publication: ProviderQualificationPublicationCapsule,
  releaseTrustPolicy: ProviderQualificationReleaseTrustPolicy,
): ExternalCanaryPublicationReservation {
  return stageExternalCanaryDirectory(outputDir, manifestSha256, (staging) => {
    writeProviderQualificationPublicationIntoReservedDirectory(
      staging,
      publication,
      releaseTrustPolicy,
    );
    for (const name of [
      "qualification.json",
      "qualification.md",
      "publication.json",
      "publication.md",
    ]) {
      const descriptor = openSync(path.join(staging, name), "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  });
}

interface ExternalCanaryRecoveryContext {
  config: ExternalProviderCanaryConfig;
  baseDir: string;
  manifestSha256: string;
  scenarioId: string;
  runId: string;
  stateDir: string;
  output: string;
  staging: string;
  lock: string;
  journalFile: string;
  journal: ExternalCanaryRunJournal;
  releaseTrustPolicy: ProviderQualificationReleaseTrustPolicy;
}

function validateExternalCanaryJournal(
  value: unknown,
  expected: { manifestSha256: string; scenarioId: string; runId: string },
): ExternalCanaryRunJournal {
  const journal = record(
    value,
    "recovery journal",
  ) as unknown as ExternalCanaryRunJournal;
  const statuses: readonly ExternalCanaryJournalStatus[] = [
    "in-progress",
    "consumed",
    "reconciliation-required",
    "abandoned",
    "reconciled",
    "recovered",
  ];
  const phases: readonly ExternalCanaryJournalPhase[] = [
    "reserved",
    "operator-boundary-entered",
    "observer-started",
    "ingress-started",
    "ingress-completed",
    "proofs-completed",
    "cleanup-completed",
    "publication-staged",
    "manifest-consumed",
    "publication-committed",
    "failed",
  ];
  const dispositions: readonly ExternalCanaryEffectDisposition[] = [
    "proven-pre-ingress",
    "ambiguous-effect",
    "publication-recoverable",
    "complete",
    "operator-reconciled",
  ];
  if (
    journal.schema !== EXTERNAL_PROVIDER_CANARY_JOURNAL_SCHEMA ||
    journal.manifestSha256 !== expected.manifestSha256 ||
    journal.scenarioId !== expected.scenarioId ||
    journal.runId !== expected.runId ||
    !statuses.includes(journal.status) ||
    !phases.includes(journal.phase) ||
    !dispositions.includes(journal.effectDisposition) ||
    !Array.isArray(journal.transitions) ||
    journal.transitions.length === 0 ||
    journal.transitions.length > 128
  ) {
    throw new Error(
      "external provider-canary recovery journal is invalid or belongs to another run",
    );
  }
  let previous = -Infinity;
  for (const transition of journal.transitions) {
    if (
      transition === null ||
      typeof transition !== "object" ||
      !statuses.includes(transition.status) ||
      !phases.includes(transition.phase) ||
      !dispositions.includes(transition.effectDisposition) ||
      !Number.isFinite(Date.parse(transition.atIso)) ||
      new Date(Date.parse(transition.atIso)).toISOString() !==
        transition.atIso ||
      Date.parse(transition.atIso) < previous
    ) {
      throw new Error(
        "external provider-canary recovery journal transition is invalid",
      );
    }
    previous = Date.parse(transition.atIso);
  }
  const last = journal.transitions[journal.transitions.length - 1];
  if (
    last.status !== journal.status ||
    last.phase !== journal.phase ||
    last.effectDisposition !== journal.effectDisposition ||
    last.atIso !== journal.updatedAtIso ||
    (journal.publicationSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(journal.publicationSha256)) ||
    (journal.reconciliationStatementSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(journal.reconciliationStatementSha256))
  ) {
    throw new Error(
      "external provider-canary recovery journal projection changed",
    );
  }
  return journal;
}

function readExternalCanaryRecoveryContext(
  configFile: string,
): ExternalCanaryRecoveryContext {
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
  const authority = readKeys(baseDir, config.manifestAuthorityPublicKeyFiles);
  const preflight = preflightAuthorizedProviderCanaryExecution({
    scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: authority,
    operationKind: config.operationKind,
    providerTarget: readJson(
      resolve(baseDir, config.providerTargetFile),
      "target",
    ),
    operationInput: readJson(
      resolve(baseDir, config.operationInputFile),
      "input",
    ),
    failureProbes: readJson(
      resolve(baseDir, config.failureProbesFile),
      "failure probes",
    ) as readonly [
      ProviderFailureProbeMaterial,
      ProviderFailureProbeMaterial,
      ...ProviderFailureProbeMaterial[],
    ],
  });
  const releaseTrustPolicy = validateProviderQualificationReleaseTrustPolicy(
    readJson(
      resolve(baseDir, config.releaseTrustPolicyFile),
      "release trust policy",
    ),
  );
  const stateDir = validateProtectedOperatorStateDirectory(
    resolve(baseDir, config.operatorStateDir),
  );
  const manifestSha256 = preflight.authorization.manifest.manifestSha256;
  const journalFile = path.join(stateDir, `${manifestSha256}.journal.json`);
  const journal = validateExternalCanaryJournal(
    readJson(journalFile, "operator journal"),
    {
      manifestSha256,
      scenarioId: scenario.id,
      runId: preflight.authorization.manifest.run.runId,
    },
  );
  const requestedOutput = path.resolve(baseDir, config.outputDir);
  const parent = validateProtectedPublicationParent(
    path.dirname(requestedOutput),
  );
  const output = path.join(parent, path.basename(requestedOutput));
  return {
    config,
    baseDir,
    manifestSha256,
    scenarioId: scenario.id,
    runId: preflight.authorization.manifest.run.runId,
    stateDir,
    output,
    staging: path.join(
      parent,
      `.${path.basename(output)}.${manifestSha256}.staging`,
    ),
    lock: path.join(parent, `.${path.basename(output)}.publish.lock`),
    journalFile,
    journal,
    releaseTrustPolicy,
  };
}

function exactProtectedPublicationFiles(
  directory: string,
  policy: ProviderQualificationReleaseTrustPolicy,
): ProviderQualificationPublicationCapsule {
  const metadata = lstatSync(directory);
  const uid = process.getuid?.();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      "recoverable provider publication directory is not protected",
    );
  }
  const expectedNames = [
    "publication.json",
    "publication.md",
    "qualification.json",
    "qualification.md",
  ].sort();
  const names = readdirSync(directory).sort();
  if (names.join("\n") !== expectedNames.join("\n")) {
    throw new Error("recoverable provider publication inventory is not exact");
  }
  for (const name of names) {
    const file = lstatSync(path.join(directory, name));
    if (
      file.isSymbolicLink() ||
      !file.isFile() ||
      file.nlink !== 1 ||
      (uid !== undefined && file.uid !== uid) ||
      (file.mode & 0o077) !== 0
    ) {
      throw new Error(
        "recoverable provider publication contains an unsafe file",
      );
    }
  }
  const publication = reverifyProviderQualificationPublication(
    JSON.parse(
      readStableOperatorFile(
        path.join(directory, "publication.json"),
        "recoverable publication",
      ).toString("utf8"),
    ) as unknown,
    policy,
  );
  const expected = {
    "publication.json": `${JSON.stringify(publication, null, 2)}\n`,
    "publication.md": renderProviderQualificationPublicationMarkdown(
      publication,
      policy,
    ),
    "qualification.json": `${JSON.stringify(
      publication.qualificationArtifact,
      null,
      2,
    )}\n`,
    "qualification.md": renderProviderQualificationMarkdown(
      publication.qualificationArtifact,
    ),
  };
  for (const [name, contents] of Object.entries(expected)) {
    if (
      readStableOperatorFile(
        path.join(directory, name),
        "recoverable publication file",
      ).toString("utf8") !== contents
    ) {
      throw new Error("recoverable provider publication derivation changed");
    }
  }
  return publication;
}

export interface ExternalCanaryRecoveryInspection {
  journalKind: "external-canary";
  manifestSha256: string;
  scenarioId: string;
  runId: string;
  status: ExternalCanaryJournalStatus;
  phase: ExternalCanaryJournalPhase;
  effectDisposition: ExternalCanaryEffectDisposition;
  journalSha256: string;
  requiredAction: ProviderRunReconciliationAction | "none";
  stagedPublicationSha256?: string;
}

/** Inspect protected state and reverify any recovery candidate without effects. */
export function inspectExternalCanaryRecovery(
  configFile: string,
): ExternalCanaryRecoveryInspection {
  const context = readExternalCanaryRecoveryContext(configFile);
  let requiredAction: ExternalCanaryRecoveryInspection["requiredAction"];
  let stagedPublicationSha256: string | undefined;
  if (
    context.journal.effectDisposition === "complete" ||
    ["abandoned", "reconciled", "recovered"].includes(context.journal.status)
  ) {
    requiredAction = "none";
  } else if (
    context.journal.status === "consumed" &&
    context.journal.effectDisposition === "publication-recoverable"
  ) {
    const candidate = existsSync(context.staging)
      ? context.staging
      : existsSync(context.output)
        ? context.output
        : undefined;
    if (!candidate)
      throw new Error("consumed provider run has no recoverable publication");
    const publication = exactProtectedPublicationFiles(
      candidate,
      context.releaseTrustPolicy,
    );
    if (
      publication.scenarioId !== context.scenarioId ||
      publication.runId !== context.runId ||
      publication.manifestSha256 !== context.manifestSha256 ||
      (context.journal.publicationSha256 !== undefined &&
        publication.publicationSha256 !== context.journal.publicationSha256)
    ) {
      throw new Error(
        "recoverable publication does not match the consumed run",
      );
    }
    requiredAction = "recover-staged-publication";
    stagedPublicationSha256 = publication.publicationSha256;
  } else if (
    context.journal.status === "in-progress" &&
    context.journal.phase === "reserved" &&
    context.journal.effectDisposition === "proven-pre-ingress"
  ) {
    requiredAction = "abandon-proven-pre-ingress";
  } else {
    requiredAction = "acknowledge-provider-reconciled";
  }
  return {
    journalKind: "external-canary",
    manifestSha256: context.manifestSha256,
    scenarioId: context.scenarioId,
    runId: context.runId,
    status: context.journal.status,
    phase: context.journal.phase,
    effectDisposition: context.journal.effectDisposition,
    journalSha256: providerRunJournalSha256(context.journal),
    requiredAction,
    ...(stagedPublicationSha256 === undefined
      ? {}
      : { stagedPublicationSha256 }),
  };
}

/** Apply one signed offline reconciliation while retaining the journal file. */
export function reconcileExternalCanaryRecovery(input: {
  configFile: string;
  signedReconciliationFile: string;
  now?: Date;
}): ExternalCanaryRecoveryInspection {
  const context = readExternalCanaryRecoveryContext(input.configFile);
  const inspection = inspectExternalCanaryRecovery(input.configFile);
  if (inspection.requiredAction === "none") return inspection;
  const statement = readJson(
    path.resolve(input.signedReconciliationFile),
    "signed reconciliation",
  );
  verifySignedProviderRunReconciliation({
    value: statement,
    journal: context.journal,
    expectedJournalKind: "external-canary",
    expectedTargetSha256: context.manifestSha256,
    expectedAction: inspection.requiredAction,
    authorityPins:
      context.releaseTrustPolicy.organizations.manifestAuthority.keys,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const reservation: ExternalCanaryJournalReservation = {
    file: context.journalFile,
    value: context.journal,
  };
  const statementSha256 = canonicalSha256(
    statement,
    "signedProviderRunReconciliation",
  );
  if (inspection.requiredAction === "recover-staged-publication") {
    if (existsSync(context.staging)) {
      if (existsSync(context.output))
        throw new Error("recovery refuses competing staged and final output");
      renameSync(context.staging, context.output);
      fsyncDirectory(path.dirname(context.output));
    }
    const publication = exactProtectedPublicationFiles(
      context.output,
      context.releaseTrustPolicy,
    );
    if (existsSync(context.lock)) {
      const lock = lstatSync(context.lock);
      const uid = process.getuid?.();
      if (
        lock.isSymbolicLink() ||
        !lock.isFile() ||
        lock.nlink !== 1 ||
        (uid !== undefined && lock.uid !== uid) ||
        (lock.mode & 0o077) !== 0
      )
        throw new Error("recovery publication lock is unsafe");
      unlinkSync(context.lock);
      fsyncDirectory(path.dirname(context.output));
    }
    transitionExternalCanaryJournal(reservation, {
      status: "recovered",
      phase: "publication-committed",
      effectDisposition: "complete",
      publicationSha256: publication.publicationSha256,
      reconciliationStatementSha256: statementSha256,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } else {
    transitionExternalCanaryJournal(reservation, {
      status:
        inspection.requiredAction === "abandon-proven-pre-ingress"
          ? "abandoned"
          : "reconciled",
      phase: "failed",
      effectDisposition: "operator-reconciled",
      reconciliationStatementSha256: statementSha256,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }
  return inspectExternalCanaryRecovery(input.configFile);
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
  const bytes = readStableOperatorFile(absoluteModuleFile, "operator module");
  inspectPinnedOperatorModuleBytes(bytes, expectedSha256);
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
  const deploymentAttestationIssuers = readKeys(
    baseDir,
    config.deploymentAttestationIssuerPublicKeyFiles,
  );
  const semantic = readKeys(baseDir, config.semanticJudgePublicKeyFiles);
  const releaseTrustPolicy = validateProviderQualificationReleaseTrustPolicy(
    readJson(
      resolve(baseDir, config.releaseTrustPolicyFile),
      "release trust policy",
    ),
  ) as ProviderQualificationReleaseTrustPolicy;
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
  let rendered: string | undefined;
  try {
    transitionExternalCanaryJournal(reservation, {
      phase: "operator-boundary-entered",
      effectDisposition: "ambiguous-effect",
    });
    const module = await (
      dependencies.loadOperatorModule ??
      loadPinnedExternalProviderCapabilityModule
    )(resolve(baseDir, config.operatorModuleFile), config.operatorModuleSha256);
    const bundle = validateExternalProviderCapabilityBundle(
      await module.createExternalProviderCanaryCapabilities({
        scenarioId: scenario.id,
        operationKind: config.operationKind,
        runId: preflight.authorization.manifest.run.runId,
        manifestSha256: preflight.authorization.manifest.manifestSha256,
        repositorySha: preflight.authorization.manifest.run.repositorySha,
        deploymentSha: preflight.authorization.manifest.run.deploymentSha,
      }),
    );
    await executeExternalProviderCanary({
      scenario,
      authorization,
      pinnedManifestAuthorityPublicKeysPem: authority,
      operationKind: config.operationKind,
      providerTarget,
      operationInput,
      failureProbes,
      pinnedObserverPublicKeysPem: observers,
      pinnedDeploymentAttestationIssuerPublicKeysPem:
        deploymentAttestationIssuers,
      pinnedSemanticJudgePublicKeysPem: semantic,
      capabilities: {
        ...bundle.capabilities,
        publisher: {
          async publish(artifact) {
            const publicationCapsule = assembleProviderQualificationPublication(
              {
                artifact,
                cleanupProof: bundle.takeVerifiedCleanupProof(),
                cleanupPublicKeyPem: bundle.cleanupPublicKeyPem,
                createdAtIso: new Date().toISOString(),
                releaseTrustPolicy,
              },
            );
            publication = stageProviderQualificationOutput(
              resolve(baseDir, config.outputDir),
              preflight.authorization.manifest.manifestSha256,
              publicationCapsule,
              releaseTrustPolicy,
            );
            rendered = renderProviderQualificationPublicationMarkdown(
              publicationCapsule,
              releaseTrustPolicy,
            );
          },
        },
      },
      maxSignatureAgeMs:
        config.maxSignatureAgeMs ?? EXTERNAL_CANARY_MAX_SIGNATURE_AGE_MS,
      maxClockSkewMs:
        config.maxClockSkewMs ?? EXTERNAL_CANARY_MAX_CLOCK_SKEW_MS,
      onProgress(stage) {
        const mapped: Pick<
          Parameters<typeof transitionExternalCanaryJournal>[1],
          "phase" | "effectDisposition"
        > =
          stage === "observer-starting" || stage === "observer-started"
            ? {
                phase: "observer-started",
                effectDisposition: "ambiguous-effect",
              }
            : stage === "ingress-starting"
              ? {
                  phase: "ingress-started",
                  effectDisposition: "ambiguous-effect",
                }
              : stage === "ingress-completed"
                ? {
                    phase: "ingress-completed",
                    effectDisposition: "ambiguous-effect",
                  }
                : stage === "proofs-completed"
                  ? {
                      phase: "proofs-completed",
                      effectDisposition: "ambiguous-effect",
                    }
                  : stage === "cleanup-completed"
                    ? {
                        phase: "cleanup-completed",
                        effectDisposition: "ambiguous-effect",
                      }
                    : stage === "publication-starting"
                      ? {
                          phase: "cleanup-completed",
                          effectDisposition: "ambiguous-effect",
                        }
                      : {
                          phase: "publication-staged",
                          effectDisposition: "publication-recoverable",
                        };
        transitionExternalCanaryJournal(reservation, {
          ...mapped,
          ...(stage === "published" && publication
            ? {
                publicationSha256: JSON.parse(
                  readStableOperatorFile(
                    path.join(publication.staging, "publication.json"),
                    "staged qualification publication",
                  ).toString("utf8"),
                ).publicationSha256 as string,
              }
            : {}),
        });
      },
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
    transitionExternalCanaryJournal(reservation, {
      status: "consumed",
      phase: "publication-committed",
      effectDisposition: "complete",
    });
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
  if (rendered === undefined) {
    throw new Error("external provider-canary publication summary is missing");
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
  if (argv.length === 2 && argv[0] === "inspect") {
    process.stdout.write(
      `${JSON.stringify(inspectExternalCanaryRecovery(argv[1]), null, 2)}\n`,
    );
    return 0;
  }
  if (argv.length === 3 && argv[0] === "reconcile") {
    process.stdout.write(
      `${JSON.stringify(
        reconcileExternalCanaryRecovery({
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
