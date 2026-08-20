/**
 * Implements the offline provider-qualification verifier and renderer. The
 * command consumes operator-authorized, independently signed artifacts from a
 * completed external run; it never receives connector credentials or executes
 * provider ingress.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "../loader.ts";
import type { ScenarioReport } from "../types.ts";
import {
  PROVIDER_OPERATION_KINDS,
  type ProviderOperationKind,
} from "./operation-binding.ts";
import {
  type ProviderCanaryAuthorization,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";
import type {
  SignedProviderObserverEvidence,
  SignedSemanticJudgeEvidence,
} from "./qualification.ts";
import {
  assembleProviderQualificationArtifact,
  type ProviderQualificationArtifact,
} from "./qualification-artifact.ts";
import {
  assembleProviderQualificationCatalog,
  type ProviderQualificationCatalog,
  renderProviderQualificationCatalogMarkdown,
} from "./qualification-catalog.ts";
import { verifyScenarioTrajectories } from "./trajectory-verifier.ts";

export const PROVIDER_QUALIFICATION_VERIFY_CONFIG_SCHEMA =
  "eliza.provider-qualification-verify-config.v1" as const;
export const PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA =
  "eliza.provider-qualification-catalog-config.v1" as const;

export interface ProviderQualificationVerifyConfig {
  schema: typeof PROVIDER_QUALIFICATION_VERIFY_CONFIG_SCHEMA;
  scenarioFile: string;
  authorizationFile: string;
  operationKind: ProviderOperationKind;
  providerTargetFile: string;
  operationInputFile: string;
  manifestAuthorityPublicKeyFiles: readonly [string, ...string[]];
  runDir: string;
  observerEvidenceFile: string;
  observerPublicKeyFiles: readonly [string, ...string[]];
  semanticEvidenceFile: string;
  semanticJudgePublicKeyFiles: readonly [string, ...string[]];
  runnerReportFile: string;
  outputDir: string;
  expectedTrajectoryRelativePaths?: readonly string[];
  maxArtifactAgeMs?: number;
  maxSignatureAgeMs?: number;
  maxClockSkewMs?: number;
}

export interface ProviderQualificationCatalogConfig {
  schema: typeof PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA;
  expectedScenarioIds: readonly [string, ...string[]];
  expectedRepositorySha: string;
  artifactFiles: readonly [string, ...string[]];
  outputDir: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
): readonly [string, ...string[]] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value as [string, ...string[]];
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function parseProviderQualificationVerifyConfig(
  value: unknown,
): ProviderQualificationVerifyConfig {
  const input = record(value, "verify config");
  const required = [
    "schema",
    "scenarioFile",
    "authorizationFile",
    "operationKind",
    "providerTargetFile",
    "operationInputFile",
    "manifestAuthorityPublicKeyFiles",
    "runDir",
    "observerEvidenceFile",
    "observerPublicKeyFiles",
    "semanticEvidenceFile",
    "semanticJudgePublicKeyFiles",
    "runnerReportFile",
    "outputDir",
  ];
  const optional = [
    "expectedTrajectoryRelativePaths",
    "maxArtifactAgeMs",
    "maxSignatureAgeMs",
    "maxClockSkewMs",
  ];
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(input, key));
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `verify config violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  if (input.schema !== PROVIDER_QUALIFICATION_VERIFY_CONFIG_SCHEMA) {
    throw new Error("verify config schema is unsupported");
  }
  const operationKind = requiredString(input.operationKind, "operationKind");
  if (
    !(PROVIDER_OPERATION_KINDS as readonly string[]).includes(operationKind)
  ) {
    throw new Error("operationKind is unsupported");
  }
  const expected = input.expectedTrajectoryRelativePaths;
  if (
    expected !== undefined &&
    (!Array.isArray(expected) ||
      expected.some((item) => typeof item !== "string"))
  ) {
    throw new Error("expectedTrajectoryRelativePaths must be a string array");
  }
  return {
    schema: PROVIDER_QUALIFICATION_VERIFY_CONFIG_SCHEMA,
    scenarioFile: requiredString(input.scenarioFile, "scenarioFile"),
    authorizationFile: requiredString(
      input.authorizationFile,
      "authorizationFile",
    ),
    operationKind: operationKind as ProviderOperationKind,
    providerTargetFile: requiredString(
      input.providerTargetFile,
      "providerTargetFile",
    ),
    operationInputFile: requiredString(
      input.operationInputFile,
      "operationInputFile",
    ),
    manifestAuthorityPublicKeyFiles: stringArray(
      input.manifestAuthorityPublicKeyFiles,
      "manifestAuthorityPublicKeyFiles",
    ),
    runDir: requiredString(input.runDir, "runDir"),
    observerEvidenceFile: requiredString(
      input.observerEvidenceFile,
      "observerEvidenceFile",
    ),
    observerPublicKeyFiles: stringArray(
      input.observerPublicKeyFiles,
      "observerPublicKeyFiles",
    ),
    semanticEvidenceFile: requiredString(
      input.semanticEvidenceFile,
      "semanticEvidenceFile",
    ),
    semanticJudgePublicKeyFiles: stringArray(
      input.semanticJudgePublicKeyFiles,
      "semanticJudgePublicKeyFiles",
    ),
    runnerReportFile: requiredString(
      input.runnerReportFile,
      "runnerReportFile",
    ),
    outputDir: requiredString(input.outputDir, "outputDir"),
    ...(expected === undefined
      ? {}
      : { expectedTrajectoryRelativePaths: expected as string[] }),
    ...(optionalInteger(input.maxArtifactAgeMs, "maxArtifactAgeMs") ===
    undefined
      ? {}
      : { maxArtifactAgeMs: input.maxArtifactAgeMs as number }),
    ...(optionalInteger(input.maxSignatureAgeMs, "maxSignatureAgeMs") ===
    undefined
      ? {}
      : { maxSignatureAgeMs: input.maxSignatureAgeMs as number }),
    ...(optionalInteger(input.maxClockSkewMs, "maxClockSkewMs") === undefined
      ? {}
      : { maxClockSkewMs: input.maxClockSkewMs as number }),
  };
}

export function parseProviderQualificationCatalogConfig(
  value: unknown,
): ProviderQualificationCatalogConfig {
  const input = record(value, "catalog config");
  const expected = [
    "schema",
    "expectedScenarioIds",
    "expectedRepositorySha",
    "artifactFiles",
    "outputDir",
  ];
  const missing = expected.filter((key) => !Object.hasOwn(input, key));
  const unknown = Object.keys(input).filter((key) => !expected.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `catalog config violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  if (input.schema !== PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA) {
    throw new Error("catalog config schema is unsupported");
  }
  const repositorySha = requiredString(
    input.expectedRepositorySha,
    "expectedRepositorySha",
  );
  if (!/^[a-f0-9]{40}$/.test(repositorySha)) {
    throw new Error(
      "expectedRepositorySha must be a lowercase 40-character Git SHA",
    );
  }
  return {
    schema: PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA,
    expectedScenarioIds: stringArray(
      input.expectedScenarioIds,
      "expectedScenarioIds",
    ),
    expectedRepositorySha: repositorySha,
    artifactFiles: stringArray(input.artifactFiles, "artifactFiles"),
    outputDir: requiredString(input.outputDir, "outputDir"),
  };
}

function readJson<T>(file: string, label: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    // error-policy:J2 preserve file or JSON failures at the CLI boundary.
    throw new Error(`failed to read ${label} from ${file}`, { cause: error });
  }
}

function resolveFrom(baseDir: string, candidate: string): string {
  return path.resolve(baseDir, candidate);
}

function readPublicKeys(
  baseDir: string,
  files: readonly [string, ...string[]],
): [string, ...string[]] {
  return files.map((file) =>
    readFileSync(resolveFrom(baseDir, file), "utf8"),
  ) as [string, ...string[]];
}

export function renderProviderQualificationMarkdown(
  artifact: ProviderQualificationArtifact,
): string {
  const qualified = artifact.decision.qualification.status === "qualified";
  const reasons =
    artifact.decision.qualification.reasons.length === 0
      ? "None"
      : artifact.decision.qualification.reasons
          .map((reason) => `\`${reason}\``)
          .join(", ");
  return [
    `## Provider qualification: ${artifact.scenarioId}`,
    "",
    `- Status: **${qualified ? "QUALIFIED" : "UNQUALIFIED"}**`,
    `- Publishable: **${artifact.decision.qualification.publishable ? "yes" : "no"}**`,
    `- Repository SHA: \`${artifact.repositorySha}\``,
    `- Deployment SHA: \`${artifact.deploymentSha}\``,
    `- Run ID: \`${artifact.runId}\``,
    `- Manifest SHA-256: \`${artifact.manifestSha256}\``,
    `- Trajectory set SHA-256: \`${artifact.trajectorySetSha256}\``,
    `- Artifact SHA-256: \`${artifact.artifactSha256}\``,
    `- Provider authorization verified: **${artifact.decision.guarantees.providerAuthorizationVerified ? "yes" : "no"}**`,
    `- Provider acceptance verified: **${artifact.decision.guarantees.providerAcceptanceVerified ? "yes" : "no"}**`,
    `- Provider readback verified: **${artifact.decision.guarantees.providerReadbackVerified ? "yes" : "no"}**`,
    `- Idempotent replay verified: **${artifact.decision.guarantees.providerIdempotencyVerified ? "yes" : "no"}**`,
    `- Reasons: ${reasons}`,
    "",
    "This summary contains hashes and qualification state only; provider receipts and signed evidence remain in the operator-controlled artifact bundle.",
    "",
  ].join("\n");
}

function writeExclusiveOutput(
  outputDir: string,
  artifact: ProviderQualificationArtifact,
): void {
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  const jsonTemporary = path.join(outputDir, ".qualification.json.tmp");
  const markdownTemporary = path.join(outputDir, ".qualification.md.tmp");
  writeFileSync(jsonTemporary, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(
    markdownTemporary,
    renderProviderQualificationMarkdown(artifact),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  renameSync(jsonTemporary, path.join(outputDir, "qualification.json"));
  renameSync(markdownTemporary, path.join(outputDir, "qualification.md"));
}

function writeExclusiveCatalogOutput(
  outputDir: string,
  catalog: ProviderQualificationCatalog,
): void {
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  writeFileSync(
    path.join(outputDir, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(outputDir, "catalog.md"),
    renderProviderQualificationCatalogMarkdown(catalog),
    { flag: "wx", mode: 0o600 },
  );
}

export async function verifyProviderQualificationFromConfig(
  configFile: string,
  now = new Date(),
): Promise<ProviderQualificationArtifact> {
  const absoluteConfigFile = path.resolve(configFile);
  const baseDir = path.dirname(absoluteConfigFile);
  const config = parseProviderQualificationVerifyConfig(
    readJson(absoluteConfigFile, "verify config"),
  );
  const scenario = (
    await loadScenarioFile(resolveFrom(baseDir, config.scenarioFile))
  ).scenario;
  const authorization = readJson<ProviderCanaryAuthorization>(
    resolveFrom(baseDir, config.authorizationFile),
    "operator authorization",
  );
  const authorityPins = readPublicKeys(
    baseDir,
    config.manifestAuthorityPublicKeyFiles,
  );
  const authorized = preflightAuthorizedProviderCanaryExecution({
    scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: authorityPins,
    operationKind: config.operationKind,
    providerTarget: readJson(
      resolveFrom(baseDir, config.providerTargetFile),
      "provider target",
    ),
    operationInput: readJson(
      resolveFrom(baseDir, config.operationInputFile),
      "provider operation input",
    ),
  });
  const signedEvidence = readJson<SignedProviderObserverEvidence>(
    resolveFrom(baseDir, config.observerEvidenceFile),
    "provider observer evidence",
  );
  const signedSemanticEvidence = readJson<SignedSemanticJudgeEvidence>(
    resolveFrom(baseDir, config.semanticEvidenceFile),
    "semantic judge evidence",
  );
  const runnerReport = readJson<ScenarioReport>(
    resolveFrom(baseDir, config.runnerReportFile),
    "runner report",
  );
  const manifest = authorized.authorization.manifest;
  const connectorEnvironment = manifest.connectors[0]?.environment;
  if (
    !connectorEnvironment ||
    manifest.connectors.some(
      (connector) => connector.environment !== connectorEnvironment,
    )
  ) {
    throw new Error(
      "all manifest connectors must share one observer environment",
    );
  }
  const trajectories = verifyScenarioTrajectories({
    runDir: resolveFrom(baseDir, config.runDir),
    runId: manifest.run.runId,
    scenarioId: scenario.id,
    scenarioStartedAtIso: signedEvidence.payload.scenarioStartedAtIso,
    scenarioEndedAtIso: signedEvidence.payload.scenarioEndedAtIso,
    environment: connectorEnvironment,
    ...(config.expectedTrajectoryRelativePaths === undefined
      ? {}
      : { expectedRelativePaths: config.expectedTrajectoryRelativePaths }),
    ...(config.maxArtifactAgeMs === undefined
      ? {}
      : { maxRunDirectoryAgeMs: config.maxArtifactAgeMs }),
    ...(config.maxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: config.maxClockSkewMs }),
    now,
  });
  const artifact = assembleProviderQualificationArtifact({
    scenarioDefinition: scenario,
    manifest,
    manifestSignature: authorized.authorization.manifestSignature,
    pinnedManifestAuthorityPublicKeysPem: authorityPins,
    trajectories,
    signedEvidence,
    pinnedObserverPublicKeysPem: readPublicKeys(
      baseDir,
      config.observerPublicKeyFiles,
    ),
    signedSemanticEvidence,
    pinnedSemanticJudgePublicKeysPem: readPublicKeys(
      baseDir,
      config.semanticJudgePublicKeyFiles,
    ),
    runnerReport,
    nowIso: now.toISOString(),
    ...(config.maxSignatureAgeMs === undefined
      ? {}
      : { maxSignatureAgeMs: config.maxSignatureAgeMs }),
    ...(config.maxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: config.maxClockSkewMs }),
  });
  writeExclusiveOutput(resolveFrom(baseDir, config.outputDir), artifact);
  return artifact;
}

export function verifyProviderQualificationCatalogFromConfig(
  configFile: string,
  now = new Date(),
): ProviderQualificationCatalog {
  const absoluteConfigFile = path.resolve(configFile);
  const baseDir = path.dirname(absoluteConfigFile);
  const config = parseProviderQualificationCatalogConfig(
    readJson(absoluteConfigFile, "catalog config"),
  );
  const catalog = assembleProviderQualificationCatalog({
    artifacts: config.artifactFiles.map((file) =>
      readJson(resolveFrom(baseDir, file), "qualification artifact"),
    ),
    expectedScenarioIds: config.expectedScenarioIds,
    expectedRepositorySha: config.expectedRepositorySha,
    createdAtIso: now.toISOString(),
  });
  writeExclusiveCatalogOutput(resolveFrom(baseDir, config.outputDir), catalog);
  return catalog;
}

export async function runProviderQualificationCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.length !== 2 || (argv[0] !== "verify" && argv[0] !== "catalog")) {
    process.stderr.write(
      "usage: eliza-provider-qualification <verify|catalog> <config.json>\n",
    );
    return 2;
  }
  if (argv[0] === "catalog") {
    const catalog = verifyProviderQualificationCatalogFromConfig(argv[1]);
    process.stdout.write(renderProviderQualificationCatalogMarkdown(catalog));
    return 0;
  }
  const artifact = await verifyProviderQualificationFromConfig(argv[1]);
  process.stdout.write(renderProviderQualificationMarkdown(artifact));
  return artifact.decision.qualification.publishable ? 0 : 1;
}

export function runProviderQualificationCliAndExit(): void {
  runProviderQualificationCli()
    .then((code) => process.exit(code))
    // error-policy:J1 the executable boundary reports refusal and exits nonzero.
    .catch((error: unknown) => {
      process.stderr.write(
        `[eliza-provider-qualification] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runProviderQualificationCliAndExit();
}
