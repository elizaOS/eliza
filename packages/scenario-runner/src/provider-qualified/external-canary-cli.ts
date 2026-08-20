/**
 * Provides the authorization-first executable boundary for one externally
 * hosted provider canary. The operator capability bundle is content-pinned
 * before it is imported, while the CLI owns qualification output publication.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadScenarioFile } from "../loader.ts";
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
import {
  renderProviderQualificationMarkdown,
  writeProviderQualificationOutputExclusive,
} from "./qualification-cli.ts";

export const EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA =
  "eliza.external-provider-canary-config.v1" as const;

export interface ExternalProviderCanaryConfig {
  schema: typeof EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA;
  scenarioFile: string;
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

function fail(message: string): never {
  throw new Error(`external provider-canary config ${message}`);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function publicKeyFiles(
  value: unknown,
  label: string,
): readonly [string, ...string[]] {
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

function optionalDuration(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function parseExternalProviderCanaryConfig(
  value: unknown,
): ExternalProviderCanaryConfig {
  const input = plainRecord(value, "root");
  const required = [
    "schema",
    "scenarioFile",
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
    "outputDir",
  ];
  const allowed = new Set([...required, "maxSignatureAgeMs", "maxClockSkewMs"]);
  const missing = required.filter((key) => !Object.hasOwn(input, key));
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  if (input.schema !== EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA) {
    fail("schema is unsupported");
  }
  const operationKind = requiredString(input.operationKind, "operationKind");
  if (
    !(PROVIDER_OPERATION_KINDS as readonly string[]).includes(operationKind)
  ) {
    fail("operationKind is unsupported");
  }
  const moduleSha256 = requiredString(
    input.operatorModuleSha256,
    "operatorModuleSha256",
  );
  if (!/^[a-f0-9]{64}$/.test(moduleSha256)) {
    fail("operatorModuleSha256 must be a lowercase SHA-256 digest");
  }
  const maxSignatureAgeMs = optionalDuration(
    input.maxSignatureAgeMs,
    "maxSignatureAgeMs",
  );
  const maxClockSkewMs = optionalDuration(
    input.maxClockSkewMs,
    "maxClockSkewMs",
  );
  return Object.freeze({
    schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
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
    failureProbesFile: requiredString(
      input.failureProbesFile,
      "failureProbesFile",
    ),
    manifestAuthorityPublicKeyFiles: publicKeyFiles(
      input.manifestAuthorityPublicKeyFiles,
      "manifestAuthorityPublicKeyFiles",
    ),
    observerPublicKeyFiles: publicKeyFiles(
      input.observerPublicKeyFiles,
      "observerPublicKeyFiles",
    ),
    semanticJudgePublicKeyFiles: publicKeyFiles(
      input.semanticJudgePublicKeyFiles,
      "semanticJudgePublicKeyFiles",
    ),
    operatorModuleFile: requiredString(
      input.operatorModuleFile,
      "operatorModuleFile",
    ),
    operatorModuleSha256: moduleSha256,
    outputDir: requiredString(input.outputDir, "outputDir"),
    ...(maxSignatureAgeMs === undefined ? {} : { maxSignatureAgeMs }),
    ...(maxClockSkewMs === undefined ? {} : { maxClockSkewMs }),
  });
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // error-policy:J2 Preserve the exact input boundary that failed.
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

/** Import one explicitly pinned trusted operator bundle. */
export async function loadPinnedExternalProviderCapabilityModule(
  absoluteModuleFile: string,
  expectedSha256: string,
): Promise<ExternalProviderCapabilityModule> {
  const before = readFileSync(absoluteModuleFile);
  const actualSha256 = createHash("sha256").update(before).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      "external provider-canary operator module digest does not match its config pin",
    );
  }
  const imported = (await import(
    `${pathToFileURL(absoluteModuleFile).href}?sha256=${actualSha256}`
  )) as Partial<ExternalProviderCapabilityModule>;
  const afterSha256 = createHash("sha256")
    .update(readFileSync(absoluteModuleFile))
    .digest("hex");
  if (afterSha256 !== actualSha256) {
    throw new Error(
      "external provider-canary operator module changed while it was imported",
    );
  }
  if (typeof imported.createExternalProviderCanaryCapabilities !== "function") {
    throw new Error(
      "external provider-canary operator module must export createExternalProviderCanaryCapabilities",
    );
  }
  return imported as ExternalProviderCapabilityModule;
}

export async function executeExternalProviderCanaryFromConfig(
  configFile: string,
  dependencies: { loadOperatorModule?: ModuleLoader } = {},
): Promise<number> {
  const absoluteConfigFile = path.resolve(configFile);
  const baseDir = path.dirname(absoluteConfigFile);
  const config = parseExternalProviderCanaryConfig(
    readJson(absoluteConfigFile, "external provider-canary config"),
  );
  const scenario = (
    await loadScenarioFile(resolveFrom(baseDir, config.scenarioFile))
  ).scenario;
  const authorization = readJson(
    resolveFrom(baseDir, config.authorizationFile),
    "operator authorization",
  ) as ProviderCanaryAuthorization;
  const providerTarget = readJson(
    resolveFrom(baseDir, config.providerTargetFile),
    "provider target",
  );
  const operationInput = readJson(
    resolveFrom(baseDir, config.operationInputFile),
    "provider operation input",
  );
  const failureProbes = readJson(
    resolveFrom(baseDir, config.failureProbesFile),
    "provider failure probes",
  ) as readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  const authorityPins = readPublicKeys(
    baseDir,
    config.manifestAuthorityPublicKeyFiles,
  );

  // Validate every signed private preimage before importing operator code that
  // can access credentials or perform network I/O.
  const preflight = preflightAuthorizedProviderCanaryExecution({
    scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: authorityPins,
    operationKind: config.operationKind,
    providerTarget,
    operationInput,
    failureProbes,
  });
  const loadOperatorModule =
    dependencies.loadOperatorModule ??
    loadPinnedExternalProviderCapabilityModule;
  const module = await loadOperatorModule(
    resolveFrom(baseDir, config.operatorModuleFile),
    config.operatorModuleSha256,
  );
  const operatorCapabilities =
    await module.createExternalProviderCanaryCapabilities({
      scenarioId: scenario.id,
      operationKind: config.operationKind,
      runId: preflight.authorization.manifest.run.runId,
      manifestSha256: preflight.authorization.manifest.manifestSha256,
    });
  const result = await executeExternalProviderCanary({
    scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: authorityPins,
    operationKind: config.operationKind,
    providerTarget,
    operationInput,
    failureProbes,
    pinnedObserverPublicKeysPem: readPublicKeys(
      baseDir,
      config.observerPublicKeyFiles,
    ),
    pinnedSemanticJudgePublicKeysPem: readPublicKeys(
      baseDir,
      config.semanticJudgePublicKeyFiles,
    ),
    capabilities: {
      ...operatorCapabilities,
      publisher: {
        async publish(artifact) {
          writeProviderQualificationOutputExclusive(
            resolveFrom(baseDir, config.outputDir),
            artifact,
          );
        },
      },
    },
    ...(config.maxSignatureAgeMs === undefined
      ? {}
      : { maxSignatureAgeMs: config.maxSignatureAgeMs }),
    ...(config.maxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: config.maxClockSkewMs }),
  });
  process.stdout.write(renderProviderQualificationMarkdown(result.artifact));
  return 0;
}

export async function runExternalProviderCanaryCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write(
      "usage: eliza-provider-canary <external-canary-config.json>\n",
    );
    return 2;
  }
  return executeExternalProviderCanaryFromConfig(argv[0]);
}

export function runExternalProviderCanaryCliAndExit(): void {
  runExternalProviderCanaryCli()
    .then((code) => process.exit(code))
    // error-policy:J1 The executable boundary reports refusal and exits nonzero.
    .catch((error: unknown) => {
      process.stderr.write(
        `[eliza-provider-canary] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runExternalProviderCanaryCliAndExit();
}
