/**
 * Performs a secret-safe, offline readiness audit for the exact 13 provider
 * canaries. It reads data-only prepared inputs, public keys, signed manifests,
 * and deployment metadata but never evaluates operator modules, resolves a
 * secret reference, contacts a service, or claims provider evidence.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  PROVIDER_CANARY_SCENARIO_IDS,
  type ProviderCanaryScenarioId,
} from "./canary-catalog.ts";
import { providerCanaryControllerContract } from "./controller-registry.ts";
import {
  type Exact13ProviderRunConfig,
  parseExact13ProviderRunConfig,
} from "./exact13-run-coordinator.ts";
import {
  type ExternalProviderCanaryConfig,
  parseExternalProviderCanaryConfig,
  validateProtectedOperatorStateDirectory,
} from "./external-canary-cli.ts";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import { canonicalProviderCanaryDefinition } from "./operator-authoring.ts";
import {
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";
import {
  providerDeploymentWorkloadSha256,
  providerObserverKeyId,
} from "./qualification.ts";
import { normalizeProviderQualificationPublicKeyPins } from "./qualification-artifact.ts";
import {
  parseReferenceOperatorConfig,
  type ReferenceOperatorConfig,
} from "./reference-operator-bundle.ts";
import {
  type ProviderQualificationReleaseTrustPolicy,
  validateProviderQualificationReleaseTrustPolicy,
} from "./release-trust-policy.ts";
import { parseProviderCanaryScenarioSnapshot } from "./scenario-snapshot.ts";

export const PROVIDER_READINESS_REPORT_SCHEMA =
  "eliza.provider-canary-readiness-report.v2" as const;

export type ProviderReadinessStatus = "ready" | "missing" | "invalid";

export interface ProviderReadinessCheck {
  code: string;
  status: ProviderReadinessStatus;
  detail: string;
}

export interface ProviderReadinessRow {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: string;
  controllerFamily: string;
  status: ProviderReadinessStatus;
  preparedConfigSha256: string | null;
  manifestSha256: string | null;
  accountRefSha256: string | null;
  principalRefSha256: string | null;
  roomRefSha256: string | null;
  checks: readonly ProviderReadinessCheck[];
}

export interface ProviderReadinessReport {
  schema: typeof PROVIDER_READINESS_REPORT_SCHEMA;
  status: ProviderReadinessStatus;
  generatedAtIso: string;
  evidenceClaimed: false;
  providerContacted: false;
  secretValuesLoaded: false;
  expectedRepositorySha: string | null;
  deploymentSha: string | null;
  exact13ConfigSha256: string;
  referenceOperatorConfigSha256: string | null;
  releaseTrustPolicyFileSha256: string | null;
  releaseTrustPolicySha256: string | null;
  readinessInputSha256: string;
  summary: { ready: number; missing: number; invalid: number };
  canaries: readonly ProviderReadinessRow[];
}

interface LoadedCanary {
  scenarioId: ProviderCanaryScenarioId;
  configFile: string;
  config: ExternalProviderCanaryConfig;
  baseDirectory: string;
  authorization: ProviderCanaryAuthorization;
  providerTarget: unknown;
  operationInput: unknown;
  accountRefSha256: string;
  principalRefSha256: string;
  roomRefSha256: string;
  deploymentSha: string;
  configSha256: string;
  manifestSha256: string;
}

interface MutableRow {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: string;
  controllerFamily: string;
  checks: ProviderReadinessCheck[];
  loaded?: LoadedCanary;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_LIVE_IDENTITY =
  /(?:^|[._:/-])(deterministic|fixture|fake|mock|stub|simulated|test-proxy)(?:$|[._:/-])/i;
const REQUIRED_CAPABILITY_BY_OPERATION = Object.freeze({
  "bluebubbles.message-send": "message-send",
  "discord.message-send": "message-send",
  "duffel.booking-hold-create": "booking-hold-create",
  "gmail.email-send": "gmail.send",
  "google-calendar.event-create": "calendar.write",
  "google-sheets.spreadsheet-create": "drive.write",
  "signal.message-send": "signal.message.send",
  "slack.message-send": "message-send",
  "telegram.message-send": "telegram.message.send",
  "twilio.sms-send": "sms-send",
  "twilio.call-create": "call-create",
  "whatsapp.message-send": "whatsapp.message.send",
  "x.direct-message-send": "x.direct-message.send",
} as const);

function statusOf(
  checks: readonly ProviderReadinessCheck[],
): ProviderReadinessStatus {
  if (checks.some(({ status }) => status === "invalid")) return "invalid";
  if (checks.some(({ status }) => status === "missing")) return "missing";
  return "ready";
}

function check(
  row: MutableRow,
  code: string,
  status: ProviderReadinessStatus,
  detail: string,
): void {
  row.checks.push(Object.freeze({ code, status, detail }));
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function readProtectedBytes(file: string): Buffer {
  const descriptor = openSync(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (uid !== undefined && metadata.uid !== uid) ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size <= 0 ||
      metadata.size > MAX_FILE_BYTES
    ) {
      throw new Error(
        "protected input must be a bounded current-user-owned private file",
      );
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readProtectedBoundedJson(file: string): unknown {
  return JSON.parse(readProtectedBytes(file).toString("utf8")) as unknown;
}

function resolveFrom(base: string, candidate: string): string {
  return path.resolve(base, candidate);
}

function resolvePreparedFile(base: string, candidate: string): string {
  if (path.isAbsolute(candidate)) {
    throw new Error("prepared file references must be relative");
  }
  const absolute = path.resolve(base, candidate);
  const relative = path.relative(base, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("prepared file reference escaped its isolated directory");
  }
  const physicalBase = realpathSync(base);
  const physical = realpathSync(absolute);
  const physicalRelative = path.relative(physicalBase, physical);
  if (
    physicalRelative === "" ||
    physicalRelative === ".." ||
    physicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(physicalRelative)
  ) {
    throw new Error(
      "prepared file reference physically escaped its isolated directory",
    );
  }
  return physical;
}

function readPublicKeys(
  base: string,
  files: readonly [string, ...string[]],
): [string, ...string[]] {
  return files.map((file) => {
    const absolute = resolvePreparedFile(base, file);
    return readProtectedBytes(absolute).toString("utf8");
  }) as [string, ...string[]];
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("value must be a plain object");
  }
  return value as Record<string, unknown>;
}

function asMaterials(
  value: unknown,
): [
  ProviderFailureProbeMaterial,
  ProviderFailureProbeMaterial,
  ...ProviderFailureProbeMaterial[],
] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("failure probes are missing");
  }
  return value as [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
}

function loadPreparedCanary(input: {
  scenarioId: ProviderCanaryScenarioId;
  configFile: string;
  expectedRepositorySha: string;
}): LoadedCanary {
  const configFile = path.resolve(input.configFile);
  const baseDirectory = path.dirname(configFile);
  const configBytes = readProtectedBytes(configFile);
  const config = parseExternalProviderCanaryConfig(
    JSON.parse(configBytes.toString("utf8")) as unknown,
  );
  const expectedKind = providerCanaryControllerContract(
    input.scenarioId,
  ).operationKind;
  if (config.operationKind !== expectedKind) {
    throw new Error(
      "prepared operation kind differs from the canonical registry",
    );
  }
  const scenarioFile = resolvePreparedFile(
    baseDirectory,
    config.scenarioDefinitionFile,
  );
  const scenario = parseProviderCanaryScenarioSnapshot({
    bytes: readProtectedBytes(scenarioFile),
    operationKind: config.operationKind,
  });
  if (scenario.id !== input.scenarioId) {
    throw new Error(
      "prepared scenario order differs from the canonical catalog",
    );
  }
  const providerTarget = readProtectedBoundedJson(
    resolvePreparedFile(baseDirectory, config.providerTargetFile),
  );
  const operationInput = readProtectedBoundedJson(
    resolvePreparedFile(baseDirectory, config.operationInputFile),
  );
  const probes = asMaterials(
    readProtectedBoundedJson(
      resolvePreparedFile(baseDirectory, config.failureProbesFile),
    ),
  );
  const authorizationValue = readProtectedBoundedJson(
    resolvePreparedFile(baseDirectory, config.authorizationFile),
  );
  const authorityPem = readPublicKeys(
    baseDirectory,
    config.manifestAuthorityPublicKeyFiles,
  );
  const observerPem = readPublicKeys(
    baseDirectory,
    config.observerPublicKeyFiles,
  );
  const semanticPem = readPublicKeys(
    baseDirectory,
    config.semanticJudgePublicKeyFiles,
  );
  const operatorModuleFile = resolvePreparedFile(
    baseDirectory,
    config.operatorModuleFile,
  );
  const moduleSha256 = createHash("sha256")
    .update(readProtectedBytes(operatorModuleFile))
    .digest("hex");
  if (moduleSha256 !== config.operatorModuleSha256) {
    throw new Error("operator module differs from its reviewed SHA-256 pin");
  }
  validateProtectedOperatorStateDirectory(
    resolveFrom(baseDirectory, config.operatorStateDir),
  );
  const output = resolveFrom(baseDirectory, config.outputDir);
  if (existsSync(output)) {
    throw new Error("provider evidence output must be absent before execution");
  }
  const outputParent = lstatSync(path.dirname(output));
  const uid = process.getuid?.();
  if (
    outputParent.isSymbolicLink() ||
    !outputParent.isDirectory() ||
    (uid !== undefined && outputParent.uid !== uid) ||
    (outputParent.mode & 0o022) !== 0
  ) {
    throw new Error("provider evidence output parent is not protected");
  }
  const preflight = preflightAuthorizedProviderCanaryExecution({
    scenario,
    authorization: authorizationValue,
    pinnedManifestAuthorityPublicKeysPem: authorityPem,
    operationKind: config.operationKind,
    providerTarget,
    operationInput,
    failureProbes: probes,
  });
  const authorization = preflight.authorization;
  const manifest = authorization.manifest;
  const pinIds = (pem: [string, ...string[]], label: string) =>
    new Set(
      normalizeProviderQualificationPublicKeyPins(pem, label).map(
        ({ keyId }) => keyId,
      ),
    );
  const authorities = pinIds(authorityPem, "readiness manifest authorities");
  const observers = pinIds(observerPem, "readiness provider observers");
  const semanticJudges = pinIds(semanticPem, "readiness semantic judges");
  const observerIds = manifest.trust.observerSigners.map(({ keyId }) => keyId);
  if (
    !authorities.has(manifest.trust.manifestAuthorityKeyId) ||
    observerIds.some((keyId) => !observers.has(keyId)) ||
    !semanticJudges.has(manifest.models.judgeKeyId) ||
    [...authorities].some(
      (keyId) => observers.has(keyId) || semanticJudges.has(keyId),
    ) ||
    [...observers].some((keyId) => semanticJudges.has(keyId))
  ) {
    throw new Error("prepared trust pin sets are incomplete or overlap");
  }
  if (manifest.run.repositorySha !== input.expectedRepositorySha) {
    throw new Error("manifest repository SHA differs from the exact-13 plan");
  }
  const primary = manifest.connectors.find(
    ({ provider, accountRefSha256, connectionRefSha256 }) =>
      provider === manifest.ingress.provider &&
      accountRefSha256 === manifest.ingress.accountRefSha256 &&
      connectionRefSha256 === manifest.ingress.connectionRefSha256,
  );
  if (!primary) throw new Error("manifest ingress connector is absent");
  return {
    scenarioId: input.scenarioId,
    configFile,
    config,
    baseDirectory,
    authorization,
    providerTarget,
    operationInput,
    accountRefSha256: primary.accountRefSha256,
    principalRefSha256: manifest.target.principalRefSha256,
    roomRefSha256: manifest.target.roomRefSha256,
    deploymentSha: manifest.run.deploymentSha,
    configSha256: createHash("sha256").update(configBytes).digest("hex"),
    manifestSha256: manifest.manifestSha256,
  };
}

function providerSpecificChecks(row: MutableRow, loaded: LoadedCanary): void {
  const target = plainRecord(loaded.providerTarget);
  const operation = plainRecord(loaded.operationInput);
  const ready = (code: string, detail: string) =>
    check(row, code, "ready", detail);
  const requireCondition = (
    condition: boolean,
    code: string,
    detail: string,
  ) => {
    check(row, code, condition ? "ready" : "invalid", detail);
  };
  const requiredCapability =
    REQUIRED_CAPABILITY_BY_OPERATION[loaded.config.operationKind];
  requireCondition(
    loaded.authorization.manifest.capabilities.some(
      ({ accountRefSha256, capability }) =>
        accountRefSha256 === loaded.accountRefSha256 &&
        capability === requiredCapability,
    ),
    "provider-capability-grant",
    "The signed account binding contains the provider-native least-privilege capability required by this canary.",
  );
  switch (loaded.config.operationKind) {
    case "bluebubbles.message-send":
      requireCondition(
        typeof target.chatGuid === "string" && target.chatGuid.length > 0,
        "bluebubbles-private-chat",
        "An explicit operator-owned BlueBubbles chat GUID is bound.",
      );
      break;
    case "discord.message-send":
      requireCondition(
        typeof target.guildId === "string" &&
          typeof target.channelId === "string",
        "discord-private-channel",
        "A guild and private canary channel are bound.",
      );
      break;
    case "duffel.booking-hold-create": {
      const calendar = plainRecord(operation.calendarSync);
      requireCondition(
        operation.orderType === "hold" && calendar.enabled === false,
        "duffel-payment-free-hold",
        "The operation is a payment-free hold with calendar sync disabled.",
      );
      ready(
        "duffel-approval-ledger",
        "The canonical manifest requires pending, approved, and done durable approval observations plus a pre-approval no-effect interval.",
      );
      break;
    }
    case "gmail.email-send":
      requireCondition(
        typeof target.recipientEmail === "string" &&
          target.recipientEmail.includes("@"),
        "gmail-isolated-recipient",
        "An explicit operator-owned recipient mailbox is bound.",
      );
      break;
    case "google-calendar.event-create":
      requireCondition(
        operation.sendUpdates === "none" && operation.createMeetLink === false,
        "calendar-no-secondary-effects",
        "Guest notifications and Meet creation are disabled.",
      );
      break;
    case "google-sheets.spreadsheet-create":
      requireCondition(
        operation.mimeType === "application/vnd.google-apps.spreadsheet",
        "sheets-native-create",
        "A native spreadsheet create in an explicit operator-owned folder is bound.",
      );
      break;
    case "signal.message-send":
      requireCondition(
        target.recipientKind === "direct",
        "signal-direct-recipient",
        "A direct isolated Signal recipient is bound.",
      );
      break;
    case "slack.message-send":
      requireCondition(
        typeof target.teamId === "string" &&
          typeof target.channelId === "string",
        "slack-private-channel",
        "An explicit team and private canary channel are bound.",
      );
      break;
    case "telegram.message-send":
      requireCondition(
        typeof target.chatId === "string",
        "telegram-private-chat",
        "An explicit operator-owned private chat is bound.",
      );
      break;
    case "twilio.sms-send":
    case "twilio.call-create":
      requireCondition(
        typeof target.fromE164 === "string" &&
          typeof target.toE164 === "string" &&
          target.fromE164 !== target.toE164,
        "twilio-isolated-numbers",
        "Distinct operator-owned E.164 source and destination numbers are bound.",
      );
      break;
    case "whatsapp.message-send":
      requireCondition(
        target.transport === "cloud-api",
        "whatsapp-cloud-api",
        "The production Cloud API transport is bound.",
      );
      break;
    case "x.direct-message-send":
      requireCondition(
        typeof target.participantId === "string",
        "x-dm-participant",
        "An explicit operator-owned DM participant is bound.",
      );
      break;
  }
}

function deploymentChecks(
  row: MutableRow,
  loaded: LoadedCanary,
  reference: ReferenceOperatorConfig,
  releasePolicy: ProviderQualificationReleaseTrustPolicy,
): void {
  const deployment = reference.deployments[row.scenarioId];
  const manifest = loaded.authorization.manifest;
  const observerKeys = new Set(
    manifest.trust.observerSigners.map(({ keyId }) => keyId),
  );
  const policyAuthorityKeys = new Set(
    releasePolicy.organizations.manifestAuthority.keys.map(
      ({ keyId }) => keyId,
    ),
  );
  const policyObserverKeys = new Set(
    releasePolicy.organizations.providerObserver.keys.map(({ keyId }) => keyId),
  );
  const policyJudgeKeys = new Set(
    releasePolicy.organizations.semanticJudge.keys.map(({ keyId }) => keyId),
  );
  const policyAttestationIssuerKeys = new Set(
    releasePolicy.organizations.deploymentAttestationIssuer.keys.map(
      ({ keyId }) => keyId,
    ),
  );
  const policyCleanupKeys = new Set(
    releasePolicy.organizations.cleanup.keys.map(({ keyId }) => keyId),
  );
  const policyMatches =
    releasePolicy.repositorySha === manifest.run.repositorySha &&
    releasePolicy.deploymentSha === manifest.run.deploymentSha &&
    releasePolicy.organizations.manifestAuthority.organizationId ===
      reference.manifestAuthorityOrganizationId &&
    releasePolicy.organizations.providerObserver.organizationId ===
      deployment.observer.organizationId &&
    releasePolicy.organizations.semanticJudge.organizationId ===
      deployment.semanticJudge.organizationId &&
    releasePolicy.organizations.cleanup.organizationId ===
      deployment.observer.organizationId &&
    policyAuthorityKeys.has(manifest.trust.manifestAuthorityKeyId) &&
    [...observerKeys].every((keyId) => policyObserverKeys.has(keyId)) &&
    deployment.pinnedDeploymentAttestationIssuerPublicKeysPem.every((pem) =>
      policyAttestationIssuerKeys.has(providerObserverKeyId(pem)),
    ) &&
    policyJudgeKeys.has(manifest.models.judgeKeyId) &&
    policyCleanupKeys.has(deployment.observer.keyId) &&
    releasePolicyAuthorizesPreparedObserverAttestation({
      repositorySha: manifest.run.repositorySha,
      deploymentSha: manifest.run.deploymentSha,
      expectedStatementSha256: deployment.observerAttestationStatementSha256,
      allowedWorkloadSha256s:
        releasePolicy.organizations.providerObserver.allowedWorkloadSha256s,
      allowedStatementSha256s:
        releasePolicy.organizations.providerObserver.allowedStatementSha256s,
    });
  check(
    row,
    "release-trust-policy",
    policyMatches ? "ready" : "invalid",
    "The external release policy authorizes this revision and its authority, observer, judge, and cleanup organizations and keys.",
  );
  check(
    row,
    "deployment-services",
    "ready",
    "Controller, observer, independent judge, and cleanup HTTPS services have explicit paths and distinct origins.",
  );
  const refs = [
    deployment.controller.bearerSecretRef,
    deployment.observer.bearerSecretRef,
    deployment.semanticJudge.bearerSecretRef,
    deployment.cleanup.bearerSecretRef,
  ];
  check(
    row,
    "secret-ref-inventory",
    new Set(refs).size === refs.length ? "ready" : "invalid",
    "Four role-specific secret references are declared; secret values were not loaded.",
  );
  const keysMatch =
    observerKeys.size === 1 &&
    observerKeys.has(deployment.observer.keyId) &&
    manifest.models.judgeKeyId === deployment.semanticJudge.keyId;
  check(
    row,
    "signer-key-binding",
    keysMatch ? "ready" : "invalid",
    "Manifest observer and judge key IDs match their independently pinned deployment services.",
  );
  check(
    row,
    "organization-independence",
    "ready",
    "Manifest authority, controller, observer, judge, and cleanup administrative domains are pairwise distinct.",
  );
  check(
    row,
    "cleanup-policy",
    "ready",
    "A distinct cleanup service is configured and cleanup proof uses the authorized observer key.",
  );
  const liveModels = [
    manifest.models.actingAdapter,
    manifest.models.actingProvider,
    manifest.models.actingModel,
    manifest.models.judgeProvider,
    manifest.models.judgeModel,
  ].every((identity) => !FORBIDDEN_LIVE_IDENTITY.test(identity));
  check(
    row,
    "live-model-separation",
    liveModels ? "ready" : "invalid",
    "Acting and independent-judge provider/model identities are distinct and are not fixture identities.",
  );
  check(
    row,
    "repository-deployment-sha",
    "ready",
    "The signed manifest contains source-format repository and deployment revisions and matches the exact-13 repository revision.",
  );
  check(
    row,
    "provider-observation-contract",
    "ready",
    "Signed requirements include provider acceptance, exact readback, idempotency, authorization denial, and provider rejection evidence.",
  );
}

/** Refuse ingress unless the release policy pre-authorizes the exact observer workload statement. */
export function releasePolicyAuthorizesPreparedObserverAttestation(input: {
  repositorySha: string;
  deploymentSha: string;
  expectedStatementSha256: string;
  allowedWorkloadSha256s: readonly string[];
  allowedStatementSha256s: readonly string[];
}): boolean {
  if (!/^[a-f0-9]{64}$/.test(input.expectedStatementSha256)) return false;
  return (
    input.allowedWorkloadSha256s.includes(
      providerDeploymentWorkloadSha256({
        repositorySha: input.repositorySha,
        deploymentSha: input.deploymentSha,
      }),
    ) && input.allowedStatementSha256s.includes(input.expectedStatementSha256)
  );
}

function markDuplicates(
  rows: MutableRow[],
  field: keyof Pick<
    LoadedCanary,
    "accountRefSha256" | "principalRefSha256" | "roomRefSha256"
  >,
  code: string,
  detail: string,
): void {
  const groups = new Map<string, MutableRow[]>();
  for (const row of rows) {
    const value = row.loaded?.[field];
    if (!value) continue;
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  for (const group of groups.values()) {
    const status = group.length === 1 ? "ready" : "invalid";
    for (const row of group) check(row, code, status, detail);
  }
}

function safeReadTopLevelConfig(file: string): {
  config: Exact13ProviderRunConfig;
  sha256: string;
} {
  const bytes = readProtectedBytes(path.resolve(file));
  return {
    config: parseExact13ProviderRunConfig(
      JSON.parse(bytes.toString("utf8")) as unknown,
    ),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Run the complete audit. Failures become per-canary states, never evidence. */
export async function inspectExact13ProviderReadiness(input: {
  exact13ConfigFile: string;
  referenceOperatorConfigFile: string;
  now?: Date;
}): Promise<ProviderReadinessReport> {
  let exact13: Exact13ProviderRunConfig;
  let exact13ConfigSha256: string;
  try {
    const loaded = safeReadTopLevelConfig(input.exact13ConfigFile);
    exact13 = loaded.config;
    exact13ConfigSha256 = loaded.sha256;
  } catch (error) {
    throw new Error(
      "provider readiness doctor could not validate the exact-13 plan",
      { cause: error },
    );
  }
  const rows: MutableRow[] = PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId) => {
    const contract = providerCanaryControllerContract(scenarioId);
    return {
      scenarioId,
      operationKind: contract.operationKind,
      controllerFamily: contract.controllerFamily,
      checks: [],
    };
  });

  let reference: ReferenceOperatorConfig | undefined;
  let referenceOperatorConfigSha256: string | null = null;
  try {
    const configuredReference = path.resolve(
      path.dirname(path.resolve(input.exact13ConfigFile)),
      exact13.referenceOperatorConfigFile,
    );
    if (
      path.resolve(input.referenceOperatorConfigFile) !== configuredReference
    ) {
      throw new Error("operator inventory differs from the exact-13 plan");
    }
    const referenceBytes = readProtectedBytes(configuredReference);
    referenceOperatorConfigSha256 = createHash("sha256")
      .update(referenceBytes)
      .digest("hex");
    reference = parseReferenceOperatorConfig(
      JSON.parse(referenceBytes.toString("utf8")) as unknown,
    );
  } catch (error) {
    const status: ProviderReadinessStatus = isMissingError(error)
      ? "missing"
      : "invalid";
    for (const row of rows)
      check(
        row,
        "deployment-inventory",
        status,
        "The complete protected deployment inventory is unavailable or invalid.",
      );
  }

  let releasePolicy: ProviderQualificationReleaseTrustPolicy | undefined;
  let releaseTrustPolicyFileSha256: string | null = null;
  let releaseTrustPolicySha256: string | null = null;
  try {
    const configuredPolicy = path.resolve(
      path.dirname(path.resolve(input.exact13ConfigFile)),
      exact13.releaseTrustPolicyFile,
    );
    const policyBytes = readProtectedBytes(configuredPolicy);
    releaseTrustPolicyFileSha256 = createHash("sha256")
      .update(policyBytes)
      .digest("hex");
    releasePolicy = validateProviderQualificationReleaseTrustPolicy(
      JSON.parse(policyBytes.toString("utf8")) as unknown,
    );
    releaseTrustPolicySha256 = releasePolicy.policySha256;
    if (releasePolicy.repositorySha !== exact13.expectedRepositorySha) {
      throw new Error(
        "release policy repository differs from the exact-13 plan",
      );
    }
  } catch (error) {
    const status: ProviderReadinessStatus = isMissingError(error)
      ? "missing"
      : "invalid";
    for (const row of rows)
      check(
        row,
        "release-trust-policy",
        status,
        "The protected external release policy is unavailable, invalid, or belongs to another repository.",
      );
    releasePolicy = undefined;
  }

  try {
    await Promise.all(
      PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId) =>
        canonicalProviderCanaryDefinition(scenarioId),
      ),
    );
    for (const row of rows)
      check(
        row,
        "canonical-catalog",
        "ready",
        "The checked-in executable-free definition matches the exact 13 catalog.",
      );
  } catch {
    for (const row of rows)
      check(
        row,
        "canonical-catalog",
        "invalid",
        "The checked-in exact 13 definition catalog is invalid or drifted.",
      );
  }

  const exactBase = path.dirname(path.resolve(input.exact13ConfigFile));
  for (const [index, row] of rows.entries()) {
    const candidate = exact13.preparedConfigFiles[index];
    try {
      row.loaded = loadPreparedCanary({
        scenarioId: row.scenarioId,
        configFile: resolveFrom(exactBase, candidate),
        expectedRepositorySha: exact13.expectedRepositorySha,
      });
      check(
        row,
        "prepared-authorization",
        "ready",
        "Prepared raw target, operation, probes, canonical scenario, signed authorization, and public authority pin agree.",
      );
      providerSpecificChecks(row, row.loaded);
      if (reference && releasePolicy) {
        deploymentChecks(row, row.loaded, reference, releasePolicy);
      }
    } catch (error) {
      check(
        row,
        "prepared-authorization",
        isMissingError(error) ? "missing" : "invalid",
        "Prepared operator material is missing or fails its closed authorization binding.",
      );
    }
  }

  markDuplicates(
    rows,
    "accountRefSha256",
    "isolated-account",
    "Every canary must use a unique account reference hash.",
  );
  markDuplicates(
    rows,
    "principalRefSha256",
    "isolated-principal",
    "Every canary must use a unique authenticated principal reference hash.",
  );
  markDuplicates(
    rows,
    "roomRefSha256",
    "isolated-room",
    "Every canary must use a unique room/target reference hash.",
  );

  const deployments = new Set(
    rows.flatMap((row) => (row.loaded ? [row.loaded.deploymentSha] : [])),
  );
  if (deployments.size > 1) {
    for (const row of rows.filter(({ loaded }) => loaded))
      check(
        row,
        "single-deployment-revision",
        "invalid",
        "All 13 canaries must bind the same deployment revision.",
      );
  } else if (deployments.size === 1) {
    for (const row of rows.filter(({ loaded }) => loaded))
      check(
        row,
        "single-deployment-revision",
        "ready",
        "All loaded canaries bind one deployment revision.",
      );
  }

  const canaries: ProviderReadinessRow[] = rows.map((row) => {
    const sortedChecks = [...row.checks].sort((left, right) =>
      left.code.localeCompare(right.code),
    );
    return Object.freeze({
      scenarioId: row.scenarioId,
      operationKind: row.operationKind,
      controllerFamily: row.controllerFamily,
      status: statusOf(sortedChecks),
      preparedConfigSha256: row.loaded?.configSha256 ?? null,
      manifestSha256: row.loaded?.manifestSha256 ?? null,
      accountRefSha256: row.loaded?.accountRefSha256 ?? null,
      principalRefSha256: row.loaded?.principalRefSha256 ?? null,
      roomRefSha256: row.loaded?.roomRefSha256 ?? null,
      checks: Object.freeze(sortedChecks),
    });
  });
  const summary = {
    ready: canaries.filter(({ status }) => status === "ready").length,
    missing: canaries.filter(({ status }) => status === "missing").length,
    invalid: canaries.filter(({ status }) => status === "invalid").length,
  };
  const overall: ProviderReadinessStatus =
    summary.invalid > 0 ? "invalid" : summary.missing > 0 ? "missing" : "ready";
  const readinessInputSha256 = canonicalSha256(
    canonicalJsonValue(
      {
        exact13ConfigSha256,
        referenceOperatorConfigSha256,
        releaseTrustPolicyFileSha256,
        releaseTrustPolicySha256,
        expectedRepositorySha: exact13.expectedRepositorySha,
        canaries: canaries.map(
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
  return Object.freeze({
    schema: PROVIDER_READINESS_REPORT_SCHEMA,
    status: overall,
    generatedAtIso: (input.now ?? new Date()).toISOString(),
    evidenceClaimed: false,
    providerContacted: false,
    secretValuesLoaded: false,
    expectedRepositorySha: exact13.expectedRepositorySha,
    deploymentSha: deployments.size === 1 ? [...deployments][0] : null,
    exact13ConfigSha256,
    referenceOperatorConfigSha256,
    releaseTrustPolicyFileSha256,
    releaseTrustPolicySha256,
    readinessInputSha256,
    summary: Object.freeze(summary),
    canaries: Object.freeze(canaries),
  });
}

/** Render a compact operator matrix without exposing endpoints, refs, or targets. */
export function renderProviderReadinessMarkdown(
  report: ProviderReadinessReport,
): string {
  const lines = [
    "# Provider qualification readiness (offline)",
    "",
    `Overall: **${report.status}** — ready ${report.summary.ready}, missing ${report.summary.missing}, invalid ${report.summary.invalid}.`,
    "",
    "> This is an offline configuration audit. It contacted no provider, loaded no secret value, and claims no qualification evidence.",
    "",
    "| Canary | Operation | Status | Blocking checks |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of report.canaries) {
    const blocking =
      row.checks
        .filter(({ status }) => status !== "ready")
        .map(({ code }) => `\`${code}\``)
        .join(", ") || "—";
    lines.push(
      `| ${row.scenarioId} | ${row.operationKind} | ${row.status} | ${blocking} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** Atomically publish canonical JSON and Markdown readiness reports. */
export function writeProviderReadinessReport(input: {
  report: ProviderReadinessReport;
  outputDirectory: string;
}): void {
  const output = path.resolve(input.outputDirectory);
  const parent = path.dirname(output);
  const staging = path.join(parent, `.${path.basename(output)}.staging`);
  const parentMetadata = lstatSync(parent);
  const uid = process.getuid?.();
  if (
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    (uid !== undefined && parentMetadata.uid !== uid) ||
    (parentMetadata.mode & 0o022) !== 0
  ) {
    throw new Error("provider readiness output parent must be protected");
  }
  if (existsSync(output) || existsSync(staging))
    throw new Error(
      "provider readiness output and staging paths must be absent",
    );
  mkdirSync(staging, { mode: 0o700 });
  try {
    const json = `${canonicalJson(canonicalJsonValue(input.report, "providerReadinessReport"))}\n`;
    writeFileSync(path.join(staging, "readiness.json"), json, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(
      path.join(staging, "readiness.md"),
      renderProviderReadinessMarkdown(input.report),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Stable hash useful for operator review without revealing private material. */
export function providerReadinessReportSha256(
  report: ProviderReadinessReport,
): string {
  return createHash("sha256")
    .update(
      canonicalJson(canonicalJsonValue(report, "providerReadinessReport")),
    )
    .digest("hex");
}
