/**
 * Builds and validates the immutable, data-only execution contract for a
 * provider-qualified scenario. The manifest binds one isolated run to operator
 * and observer signing authorities, real principals, connector authority,
 * ingress, deployment provenance, semantic criteria, and an exact multiset of
 * independently observed outcomes.
 */

import { createHash } from "node:crypto";
import type {
  ScenarioDefinition,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import {
  PROVIDER_OPERATION_CONTRACT_BY_KIND,
  type ProviderOperationBinding,
  validateProviderOperationBinding,
} from "./operation-binding.ts";

export const PROVIDER_QUALIFICATION_MANIFEST_SCHEMA =
  "eliza.provider-qualified-manifest.v1" as const;

type JsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | JsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type ProviderObservationKind =
  | "durable-approval"
  | "durable-draft"
  | "provider-effect"
  | "provider-no-effect"
  | "scheduled-task";

export type ProviderObservationSourceKind =
  | "provider-api"
  | "provider-webhook"
  | "durable-database"
  | "scheduler-runner";

type ObservationContractBase<
  Kind extends ProviderObservationKind,
  SourceKind extends ProviderObservationSourceKind,
> = {
  contractId: string;
  kind: Kind;
  observerId: string;
  sourceKind: SourceKind;
  system: string;
  environment: string;
  connectorProvider: string;
  accountRefSha256: string;
  connectionRefSha256: string;
  resourceRefSha256?: string;
  requiredCount: number;
  maxObservationAgeMs: number;
};

export type DurableApprovalObservationContract = ObservationContractBase<
  "durable-approval",
  "durable-database"
> & {
  operation: string;
  state: string;
};

export type DurableDraftObservationContract = ObservationContractBase<
  "durable-draft",
  "durable-database"
> & {
  state: string;
};

export type ProviderEffectObservationContract = ObservationContractBase<
  "provider-effect",
  "provider-api" | "provider-webhook"
> & {
  provider: string;
  operation: string;
  providerAcceptanceRequired: true;
  readbackRequired: true;
  idempotencyRequired: true;
};

export type ProviderNoEffectObservationContract = ObservationContractBase<
  "provider-no-effect",
  "provider-api"
> & {
  provider: string;
  effectKinds: readonly [string, ...string[]];
  scopeSha256: string;
  intervalCoverage: "full-scenario";
};

export type ScheduledTaskObservationContract = ObservationContractBase<
  "scheduled-task",
  "durable-database" | "scheduler-runner"
> & {
  state: string;
};

export type ProviderObservationContract =
  | DurableApprovalObservationContract
  | DurableDraftObservationContract
  | ProviderEffectObservationContract
  | ProviderNoEffectObservationContract
  | ScheduledTaskObservationContract;

export interface ProviderConnectorBinding {
  provider: string;
  accountRefSha256: string;
  connectionRefSha256: string;
  environment: string;
}

export interface ProviderObserverSignerBinding {
  observerId: string;
  keyId: string;
}

export interface ProviderRunBindings {
  runId: string;
  runNonce: string;
  repositorySha: string;
  deploymentSha: string;
  trust: {
    manifestAuthorityKeyId: string;
    observerSigners: readonly [
      ProviderObserverSignerBinding,
      ...ProviderObserverSignerBinding[],
    ];
  };
  target: {
    principalRefSha256: string;
    roomRefSha256: string;
    /** Typed, hash-only binding for provider-native routing and operation input. */
    operation: ProviderOperationBinding;
  };
  models: {
    actingAdapter: string;
    actingProvider: string;
    actingModel: string;
    judgeProvider: string;
    judgeModel: string;
    judgeKeyId: string;
  };
  connectors: readonly [
    ProviderConnectorBinding,
    ...ProviderConnectorBinding[],
  ];
  ingress: {
    kind: "provider-api" | "provider-webhook";
    provider: string;
    channel: string;
    accountRefSha256: string;
    connectionRefSha256: string;
    authenticatedPrincipalRefSha256: string;
    roomRefSha256: string;
    endpointOriginSha256: string;
  };
  capabilities: readonly [
    {
      provider: string;
      accountRefSha256: string;
      connectionRefSha256: string;
      capability: string;
      authorizationGrantSha256: string;
    },
    ...Array<{
      provider: string;
      accountRefSha256: string;
      connectionRefSha256: string;
      capability: string;
      authorizationGrantSha256: string;
    }>,
  ];
  observationContracts: readonly [
    ProviderObservationContract,
    ...ProviderObservationContract[],
  ];
}

export interface ProviderQualificationManifest {
  schema: typeof PROVIDER_QUALIFICATION_MANIFEST_SCHEMA;
  manifestSha256: string;
  scenario: {
    id: string;
    definitionSha256: string;
    finalChecks: readonly {
      checkId: string;
      type: string;
      definitionSha256: string;
    }[];
    semanticCriteria: readonly [
      {
        criterionId: string;
        rubricSha256: string;
        minimumScore: number;
      },
      ...Array<{
        criterionId: string;
        rubricSha256: string;
        minimumScore: number;
      }>,
    ];
  };
  run: {
    runId: string;
    nonce: string;
    repositorySha: string;
    deploymentSha: string;
  };
  trust: ProviderRunBindings["trust"];
  target: ProviderRunBindings["target"];
  models: ProviderRunBindings["models"];
  connectors: ProviderRunBindings["connectors"];
  ingress: ProviderRunBindings["ingress"];
  capabilities: ProviderRunBindings["capabilities"];
  requiredObservations: ProviderRunBindings["observationContracts"];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const MAX_CONNECTOR_BINDINGS = 64;
const MAX_CAPABILITY_BINDINGS = 256;
const MAX_OBSERVATION_CONTRACTS = 128;
const MAX_OBSERVATION_SLOTS = 256;
const MAX_MANIFEST_FINAL_CHECKS = 512;
const MAX_SEMANTIC_CRITERIA = 128;
const TRUSTED_CHECK_KIND = {
  durableApprovalObserved: "durable-approval",
  durableDraftObserved: "durable-draft",
  providerEffectObserved: "provider-effect",
  providerNoEffectObserved: "provider-no-effect",
  scheduledTaskObserved: "scheduled-task",
} as const;

type TrustedCheckType = keyof typeof TRUSTED_CHECK_KIND;
type TrustedCheck = Extract<ScenarioFinalCheck, { type: TrustedCheckType }>;

function fail(path: string, message: string): never {
  throw new Error(`provider-qualified manifest ${path} ${message}`);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function requireSha256(value: unknown, path: string): string {
  const hash = requireNonEmptyString(value, path);
  if (!SHA256_PATTERN.test(hash)) {
    fail(path, "must be a lowercase SHA-256 digest");
  }
  return hash;
}

function requireSourceSha(value: unknown, path: string): string {
  const hash = requireNonEmptyString(value, path);
  if (!SOURCE_SHA_PATTERN.test(hash)) {
    fail(path, "must be a lowercase 40- or 64-character source digest");
  }
  return hash;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(path, "must be a positive safe integer");
  }
  return Number(value);
}

function requireExactKeys(
  value: object,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      path,
      `must use the closed field set (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

/**
 * Copy an untrusted runtime value into a closed, immutable JSON tree.
 *
 * Descriptor inspection prevents getters, custom serializers, hidden fields,
 * sparse arrays, and prototype behavior from changing data after validation.
 */
export function canonicalJsonValue(
  value: unknown,
  path = "value",
): CanonicalJsonValue {
  return copyCanonicalJsonValue(value, path, new Set<object>(), 0, {
    remaining: 1_000_000,
  });
}

function copyCanonicalJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
  budget: { remaining: number },
): CanonicalJsonValue {
  if (depth > 128) {
    fail(path, "exceeds the canonical JSON nesting limit");
  }
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    fail(path, "exceeds the canonical JSON node limit");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(path, "contains a non-finite number");
    }
    return value;
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    fail(path, `contains executable or non-JSON data (${typeof value})`);
  }
  if (ancestors.has(value)) {
    fail(path, "contains a cyclic reference");
  }
  const prototype = Object.getPrototypeOf(value);
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    fail(path, "contains symbol-keyed data");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      fail(path, "contains an array with a custom prototype");
    }
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      fail(`${path}.length`, "must be a non-negative data property");
    }
    const length = lengthDescriptor.value as number;
    if (length > 100_000) {
      fail(path, "exceeds the canonical JSON array limit");
    }
    const allowedKeys = new Set([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    const unexpectedKeys = Object.keys(descriptors).filter(
      (key) => !allowedKeys.has(key),
    );
    if (unexpectedKeys.length > 0) {
      fail(
        path,
        `contains non-index array fields (${unexpectedKeys.join(",")})`,
      );
    }
    ancestors.add(value);
    const result: CanonicalJsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) {
        fail(`${path}[${index}]`, "is a sparse array slot");
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        fail(`${path}[${index}]`, "must be an enumerable data property");
      }
      result.push(
        copyCanonicalJsonValue(
          descriptor.value,
          `${path}[${index}]`,
          ancestors,
          depth + 1,
          budget,
        ),
      );
    }
    ancestors.delete(value);
    return Object.freeze(result) as unknown as CanonicalJsonValue[];
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "contains a non-plain object such as RegExp, Date, or a module");
  }
  ancestors.add(value);
  const result: Record<string, CanonicalJsonValue> = Object.create(
    null,
  ) as Record<string, CanonicalJsonValue>;
  const descriptorKeys = Object.keys(descriptors);
  if (descriptorKeys.length > 100_000) {
    fail(path, "exceeds the canonical JSON object-field limit");
  }
  for (const key of descriptorKeys.sort()) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) {
      fail(`${path}.${key}`, "must not be a hidden non-enumerable property");
    }
    if (!("value" in descriptor)) {
      fail(`${path}.${key}`, "must not be an accessor property");
    }
    result[key] = copyCanonicalJsonValue(
      descriptor.value,
      `${path}.${key}`,
      ancestors,
      depth + 1,
      budget,
    );
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

/** Stable JSON used for hashes and Ed25519 payloads across processes. */
export function canonicalJson(value: CanonicalJsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON cannot encode a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/** Hash arbitrary plain data after applying the package's canonical encoding. */
export function canonicalSha256(value: unknown, path = "value"): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalJsonValue(value, path)), "utf8")
    .digest("hex");
}

function scalarString(
  value: string | string[] | undefined,
  path: string,
): string {
  if (Array.isArray(value)) {
    fail(path, "must be one exact value rather than an alternatives list");
  }
  return requireNonEmptyString(value, path);
}

function sha256Identity(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateScenarioShape(scenario: ScenarioDefinition): void {
  canonicalJsonValue(scenario, "scenario");
  if (scenario.executionProfile !== "provider-qualified") {
    fail("scenario.executionProfile", 'must be "provider-qualified"');
  }
  if (scenario.lane !== "live-only") {
    fail("scenario.lane", 'must be explicitly "live-only"');
  }
  if (scenario.isolation !== "per-scenario") {
    fail("scenario.isolation", 'must be explicitly "per-scenario"');
  }
  if (scenario.status === "pending" || scenario.deferred) {
    fail("scenario", "cannot be pending or deferred");
  }
  if (scenario.edgeVariant || scenario.baseScenarioId) {
    fail("scenario", "cannot be a generated edge variant");
  }
  if ((scenario.mockoon?.length ?? 0) > 0) {
    fail("scenario.mockoon", "cannot configure a simulated connector");
  }
  if ((scenario.seed?.length ?? 0) > 0) {
    fail("scenario.seed", "cannot seed or mutate test-owned state");
  }
  if ((scenario.cleanup?.length ?? 0) > 0) {
    fail(
      "scenario.cleanup",
      "cannot execute custom, module, or harness-owned cleanup paths",
    );
  }
  if ((scenario.rooms?.length ?? 0) > 0) {
    fail(
      "scenario.rooms",
      "cannot override the room bound by authenticated ingress",
    );
  }
  if (scenario.turns.length === 0) {
    fail("scenario.turns", "must contain at least one real ingress turn");
  }
  for (const [index, turn] of scenario.turns.entries()) {
    if (turn.kind !== "message") {
      fail(
        `scenario.turns[${index}].kind`,
        `must explicitly declare message; ${String(turn.kind)} is not eligible`,
      );
    }
    if (typeof turn.text !== "string" || turn.text.trim().length === 0) {
      fail(`scenario.turns[${index}].text`, "must be a non-empty message");
    }
    const forbiddenKeys = [
      "actionName",
      "room",
      "content",
      "method",
      "path",
      "body",
      "captures",
      "redactResponseFields",
      "expectedStatus",
      "durationMs",
      "options",
      "worker",
      "now",
      "voiceScenario",
      "voiceServices",
      "allowVoiceSkip",
    ] as const;
    for (const key of forbiddenKeys) {
      if (Object.hasOwn(turn, key)) {
        fail(
          `scenario.turns[${index}].${key}`,
          "is a direct, synthetic, voice, or wait execution path",
        );
      }
    }
  }
  for (const [index, check] of (scenario.finalChecks ?? []).entries()) {
    if (check.type !== "judgeRubric" && !(check.type in TRUSTED_CHECK_KIND)) {
      fail(
        `scenario.finalChecks[${index}].type`,
        `${check.type} is not a trusted observer or semantic check`,
      );
    }
  }
}

function trustedChecks(scenario: ScenarioDefinition): TrustedCheck[] {
  return (scenario.finalChecks ?? []).filter(
    (check): check is TrustedCheck => check.type in TRUSTED_CHECK_KIND,
  );
}

function connectorKey(
  provider: string,
  accountRefSha256: string,
  connectionRefSha256: string,
): string {
  return `${provider}\u0000${accountRefSha256}\u0000${connectionRefSha256}`;
}

function validateContractBase(
  contract: ProviderObservationContract,
  index: number,
  connectors: ReadonlyMap<string, ProviderConnectorBinding>,
): void {
  const path = `bindings.observationContracts[${index}]`;
  requireNonEmptyString(contract.contractId, `${path}.contractId`);
  requireNonEmptyString(contract.observerId, `${path}.observerId`);
  requireNonEmptyString(contract.system, `${path}.system`);
  requireNonEmptyString(contract.environment, `${path}.environment`);
  requireNonEmptyString(
    contract.connectorProvider,
    `${path}.connectorProvider`,
  );
  requireSha256(contract.accountRefSha256, `${path}.accountRefSha256`);
  requireSha256(contract.connectionRefSha256, `${path}.connectionRefSha256`);
  if (contract.resourceRefSha256 !== undefined) {
    requireSha256(contract.resourceRefSha256, `${path}.resourceRefSha256`);
  }
  requirePositiveInteger(contract.requiredCount, `${path}.requiredCount`);
  requirePositiveInteger(
    contract.maxObservationAgeMs,
    `${path}.maxObservationAgeMs`,
  );
  const connector = connectors.get(
    connectorKey(
      contract.connectorProvider,
      contract.accountRefSha256,
      contract.connectionRefSha256,
    ),
  );
  if (!connector) {
    fail(
      path,
      "must bind a declared connector provider, account, and connection",
    );
  }
  if (contract.environment !== connector.environment) {
    fail(`${path}.environment`, "must match the bound connector environment");
  }
}

function validateContractFields(
  contract: ProviderObservationContract,
  index: number,
): void {
  const path = `bindings.observationContracts[${index}]`;
  const baseRequired = [
    "contractId",
    "kind",
    "observerId",
    "sourceKind",
    "system",
    "environment",
    "connectorProvider",
    "accountRefSha256",
    "connectionRefSha256",
    "requiredCount",
    "maxObservationAgeMs",
  ];
  const optional = ["resourceRefSha256"];
  if (contract.kind === "durable-approval") {
    requireExactKeys(
      contract,
      path,
      [...baseRequired, "operation", "state"],
      optional,
    );
    if (contract.sourceKind !== "durable-database") {
      fail(`${path}.sourceKind`, 'must be "durable-database"');
    }
    requireNonEmptyString(contract.operation, `${path}.operation`);
    requireNonEmptyString(contract.state, `${path}.state`);
  } else if (contract.kind === "durable-draft") {
    requireExactKeys(contract, path, [...baseRequired, "state"], optional);
    if (contract.sourceKind !== "durable-database") {
      fail(`${path}.sourceKind`, 'must be "durable-database"');
    }
    requireNonEmptyString(contract.state, `${path}.state`);
  } else if (contract.kind === "provider-effect") {
    requireExactKeys(
      contract,
      path,
      [
        ...baseRequired,
        "provider",
        "operation",
        "providerAcceptanceRequired",
        "readbackRequired",
        "idempotencyRequired",
      ],
      optional,
    );
    if (
      contract.sourceKind !== "provider-api" &&
      contract.sourceKind !== "provider-webhook"
    ) {
      fail(`${path}.sourceKind`, "must be a provider observer");
    }
    requireNonEmptyString(contract.provider, `${path}.provider`);
    requireNonEmptyString(contract.operation, `${path}.operation`);
    if (contract.providerAcceptanceRequired !== true) {
      fail(`${path}.providerAcceptanceRequired`, "must be true");
    }
    if (
      contract.readbackRequired !== true ||
      contract.idempotencyRequired !== true
    ) {
      fail(path, "must require provider readback and idempotency verification");
    }
  } else if (contract.kind === "provider-no-effect") {
    requireExactKeys(
      contract,
      path,
      [
        ...baseRequired,
        "provider",
        "effectKinds",
        "scopeSha256",
        "intervalCoverage",
      ],
      optional,
    );
    if (contract.sourceKind !== "provider-api") {
      fail(`${path}.sourceKind`, 'must be "provider-api"');
    }
    requireNonEmptyString(contract.provider, `${path}.provider`);
    requireSha256(contract.scopeSha256, `${path}.scopeSha256`);
    if (
      !Array.isArray(contract.effectKinds) ||
      contract.effectKinds.length === 0
    ) {
      fail(`${path}.effectKinds`, "must be a non-empty exact list");
    }
    for (const [effectIndex, effectKind] of contract.effectKinds.entries()) {
      requireNonEmptyString(effectKind, `${path}.effectKinds[${effectIndex}]`);
    }
    if (new Set(contract.effectKinds).size !== contract.effectKinds.length) {
      fail(`${path}.effectKinds`, "cannot contain duplicates");
    }
    if (contract.intervalCoverage !== "full-scenario") {
      fail(`${path}.intervalCoverage`, 'must be "full-scenario"');
    }
  } else if (contract.kind === "scheduled-task") {
    requireExactKeys(contract, path, [...baseRequired, "state"], optional);
    if (
      contract.sourceKind !== "durable-database" &&
      contract.sourceKind !== "scheduler-runner"
    ) {
      fail(`${path}.sourceKind`, "must be a durable scheduler observer");
    }
    requireNonEmptyString(contract.state, `${path}.state`);
  } else {
    fail(`${path}.kind`, "is unsupported");
  }
}

function contractMatchesCheck(
  contract: ProviderObservationContract,
  check: TrustedCheck,
  path: string,
): void {
  if (check.name !== contract.contractId) {
    fail(
      path,
      `must correspond to trusted final check "${contract.contractId}"`,
    );
  }
  if (TRUSTED_CHECK_KIND[check.type] !== contract.kind) {
    fail(path, `kind does not match ${check.type}`);
  }
  if (
    scalarString(check.observerId, `${path}.observerId`) !== contract.observerId
  ) {
    fail(path, "observer binding differs from the authored final check");
  }
  if (scalarString(check.provider, `${path}.provider`) !== contract.system) {
    fail(path, "system binding differs from the authored final check");
  }
  if (
    sha256Identity(scalarString(check.accountId, `${path}.accountId`)) !==
    contract.accountRefSha256
  ) {
    fail(path, "account binding differs from the authored final check");
  }
  if ((check.minCount ?? 1) !== contract.requiredCount) {
    fail(path, "requiredCount differs from the authored final check");
  }
  if (check.resourceId !== undefined) {
    const expectedResource = sha256Identity(
      scalarString(check.resourceId, `${path}.resourceId`),
    );
    if (contract.resourceRefSha256 !== expectedResource) {
      fail(path, "resource binding differs from the authored final check");
    }
  }
  if (
    contract.kind === "provider-effect" ||
    contract.kind === "durable-approval"
  ) {
    if (
      scalarString(check.operation, `${path}.operation`) !== contract.operation
    ) {
      fail(path, "operation differs from the authored final check");
    }
  } else if (check.operation !== undefined) {
    fail(`${path}.operation`, "is not supported for this observation kind");
  }
  if (
    contract.kind === "provider-effect" ||
    contract.kind === "provider-no-effect"
  ) {
    if (
      scalarString(check.connectorProvider, `${path}.connectorProvider`) !==
      contract.connectorProvider
    ) {
      fail(path, "connector provider differs from the authored final check");
    }
  } else if (check.connectorProvider !== undefined) {
    fail(
      `${path}.connectorProvider`,
      "is not supported for this observation kind",
    );
  }
  if (
    contract.kind === "durable-approval" ||
    contract.kind === "durable-draft" ||
    contract.kind === "scheduled-task"
  ) {
    if (scalarString(check.state, `${path}.state`) !== contract.state) {
      fail(path, "state differs from the authored final check");
    }
  } else if (check.state !== undefined) {
    fail(`${path}.state`, "is not supported for this observation kind");
  }
  if (
    contract.kind === "provider-no-effect" &&
    check.type === "providerNoEffectObserved" &&
    check.intervalCoversScenario === false
  ) {
    fail(path, "must require an observation interval covering the scenario");
  }
}

function validateBindings(
  bindings: ProviderRunBindings,
  scenario?: ScenarioDefinition,
): void {
  requireExactKeys(bindings, "bindings", [
    "runId",
    "runNonce",
    "repositorySha",
    "deploymentSha",
    "trust",
    "target",
    "models",
    "connectors",
    "ingress",
    "capabilities",
    "observationContracts",
  ]);
  requireNonEmptyString(bindings.runId, "bindings.runId");
  if (!NONCE_PATTERN.test(bindings.runNonce)) {
    fail(
      "bindings.runNonce",
      "must contain at least 32 URL-safe random characters",
    );
  }
  requireSourceSha(bindings.repositorySha, "bindings.repositorySha");
  requireSourceSha(bindings.deploymentSha, "bindings.deploymentSha");

  requireExactKeys(bindings.trust, "bindings.trust", [
    "manifestAuthorityKeyId",
    "observerSigners",
  ]);
  requireSha256(
    bindings.trust.manifestAuthorityKeyId,
    "bindings.trust.manifestAuthorityKeyId",
  );
  if (
    !Array.isArray(bindings.trust.observerSigners) ||
    bindings.trust.observerSigners.length === 0
  ) {
    fail(
      "bindings.trust.observerSigners",
      "must contain at least one observer signer",
    );
  }
  if (bindings.trust.observerSigners.length > MAX_OBSERVATION_CONTRACTS) {
    fail(
      "bindings.trust.observerSigners",
      `cannot exceed ${MAX_OBSERVATION_CONTRACTS}`,
    );
  }
  const observerSignerById = new Map<string, string>();
  const observerSignerKeyIds = new Set<string>();
  for (const [index, signer] of bindings.trust.observerSigners.entries()) {
    const path = `bindings.trust.observerSigners[${index}]`;
    requireExactKeys(signer, path, ["observerId", "keyId"]);
    const observerId = requireNonEmptyString(
      signer.observerId,
      `${path}.observerId`,
    );
    const keyId = requireSha256(signer.keyId, `${path}.keyId`);
    if (observerSignerById.has(observerId)) {
      fail(`${path}.observerId`, "is duplicated");
    }
    observerSignerById.set(observerId, keyId);
    observerSignerKeyIds.add(keyId);
  }
  if (observerSignerKeyIds.size !== 1) {
    fail(
      "bindings.trust.observerSigners",
      "must use one aggregate observer signer in protocol v1",
    );
  }

  requireExactKeys(bindings.target, "bindings.target", [
    "principalRefSha256",
    "roomRefSha256",
    "operation",
  ]);
  requireSha256(
    bindings.target.principalRefSha256,
    "bindings.target.principalRefSha256",
  );
  requireSha256(bindings.target.roomRefSha256, "bindings.target.roomRefSha256");
  validateProviderOperationBinding(bindings.target.operation);

  requireExactKeys(bindings.models, "bindings.models", [
    "actingAdapter",
    "actingProvider",
    "actingModel",
    "judgeProvider",
    "judgeModel",
    "judgeKeyId",
  ]);
  for (const key of [
    "actingAdapter",
    "actingProvider",
    "actingModel",
    "judgeProvider",
    "judgeModel",
  ] as const) {
    requireNonEmptyString(bindings.models[key], `bindings.models.${key}`);
  }
  requireSha256(bindings.models.judgeKeyId, "bindings.models.judgeKeyId");
  if (
    bindings.models.judgeKeyId === bindings.trust.manifestAuthorityKeyId ||
    observerSignerKeyIds.has(bindings.models.judgeKeyId) ||
    observerSignerKeyIds.has(bindings.trust.manifestAuthorityKeyId)
  ) {
    fail(
      "bindings.trust",
      "manifest authority, observer, and semantic judge keys must be pairwise disjoint",
    );
  }
  if (
    bindings.models.actingProvider === bindings.models.judgeProvider &&
    bindings.models.actingModel === bindings.models.judgeModel
  ) {
    fail(
      "bindings.models",
      "judge provider/model identity must differ from the acting model",
    );
  }

  if (!Array.isArray(bindings.connectors) || bindings.connectors.length === 0) {
    fail("bindings.connectors", "must contain at least one connector binding");
  }
  if (bindings.connectors.length > MAX_CONNECTOR_BINDINGS) {
    fail("bindings.connectors", `cannot exceed ${MAX_CONNECTOR_BINDINGS}`);
  }
  const connectors = new Map<string, ProviderConnectorBinding>();
  for (const [index, connector] of bindings.connectors.entries()) {
    const path = `bindings.connectors[${index}]`;
    requireExactKeys(connector, path, [
      "provider",
      "accountRefSha256",
      "connectionRefSha256",
      "environment",
    ]);
    requireNonEmptyString(connector.provider, `${path}.provider`);
    requireSha256(connector.accountRefSha256, `${path}.accountRefSha256`);
    requireSha256(connector.connectionRefSha256, `${path}.connectionRefSha256`);
    requireNonEmptyString(connector.environment, `${path}.environment`);
    const key = connectorKey(
      connector.provider,
      connector.accountRefSha256,
      connector.connectionRefSha256,
    );
    if (connectors.has(key)) {
      fail(path, "duplicates a connector provider/account/connection binding");
    }
    connectors.set(key, connector);
  }

  requireExactKeys(bindings.ingress, "bindings.ingress", [
    "kind",
    "provider",
    "channel",
    "accountRefSha256",
    "connectionRefSha256",
    "authenticatedPrincipalRefSha256",
    "roomRefSha256",
    "endpointOriginSha256",
  ]);
  if (
    bindings.ingress.kind !== "provider-api" &&
    bindings.ingress.kind !== "provider-webhook"
  ) {
    fail("bindings.ingress.kind", "must be provider-api or provider-webhook");
  }
  requireNonEmptyString(bindings.ingress.provider, "bindings.ingress.provider");
  requireNonEmptyString(bindings.ingress.channel, "bindings.ingress.channel");
  requireSha256(
    bindings.ingress.accountRefSha256,
    "bindings.ingress.accountRefSha256",
  );
  requireSha256(
    bindings.ingress.endpointOriginSha256,
    "bindings.ingress.endpointOriginSha256",
  );
  requireSha256(
    bindings.ingress.connectionRefSha256,
    "bindings.ingress.connectionRefSha256",
  );
  const ingressConnectorKey = connectorKey(
    bindings.ingress.provider,
    bindings.ingress.accountRefSha256,
    bindings.ingress.connectionRefSha256,
  );
  if (!connectors.has(ingressConnectorKey)) {
    fail(
      "bindings.ingress",
      "must bind exactly one declared connector provider/account/connection",
    );
  }
  if (
    bindings.ingress.authenticatedPrincipalRefSha256 !==
    bindings.target.principalRefSha256
  ) {
    fail(
      "bindings.ingress.authenticatedPrincipalRefSha256",
      "must match the target principal",
    );
  }
  if (bindings.ingress.roomRefSha256 !== bindings.target.roomRefSha256) {
    fail("bindings.ingress.roomRefSha256", "must match the target room");
  }

  if (
    !Array.isArray(bindings.capabilities) ||
    bindings.capabilities.length === 0
  ) {
    fail(
      "bindings.capabilities",
      "must contain at least one granted capability",
    );
  }
  if (bindings.capabilities.length > MAX_CAPABILITY_BINDINGS) {
    fail("bindings.capabilities", `cannot exceed ${MAX_CAPABILITY_BINDINGS}`);
  }
  const capabilityNames = new Set<string>();
  const connectorsWithCapabilities = new Set<string>();
  for (const [index, capability] of bindings.capabilities.entries()) {
    const path = `bindings.capabilities[${index}]`;
    requireExactKeys(capability, path, [
      "provider",
      "accountRefSha256",
      "connectionRefSha256",
      "capability",
      "authorizationGrantSha256",
    ]);
    requireNonEmptyString(capability.provider, `${path}.provider`);
    requireSha256(capability.accountRefSha256, `${path}.accountRefSha256`);
    requireSha256(
      capability.connectionRefSha256,
      `${path}.connectionRefSha256`,
    );
    const boundConnectorKey = connectorKey(
      capability.provider,
      capability.accountRefSha256,
      capability.connectionRefSha256,
    );
    if (!connectors.has(boundConnectorKey)) {
      fail(path, "must bind a declared connector provider/account/connection");
    }
    connectorsWithCapabilities.add(boundConnectorKey);
    requireNonEmptyString(capability.capability, `${path}.capability`);
    requireSha256(
      capability.authorizationGrantSha256,
      `${path}.authorizationGrantSha256`,
    );
    const capabilityKey = `${boundConnectorKey}\u0000${capability.capability}`;
    if (capabilityNames.has(capabilityKey)) {
      fail(`${path}.capability`, "is duplicated");
    }
    capabilityNames.add(capabilityKey);
  }

  if (
    !Array.isArray(bindings.observationContracts) ||
    bindings.observationContracts.length === 0
  ) {
    fail(
      "bindings.observationContracts",
      "must contain at least one exact observation contract",
    );
  }
  if (bindings.observationContracts.length > MAX_OBSERVATION_CONTRACTS) {
    fail(
      "bindings.observationContracts",
      `cannot exceed ${MAX_OBSERVATION_CONTRACTS}`,
    );
  }
  const observationSlots = bindings.observationContracts.reduce(
    (sum, contract) => sum + contract.requiredCount,
    0,
  );
  if (observationSlots > MAX_OBSERVATION_SLOTS) {
    fail(
      "bindings.observationContracts",
      `total requiredCount cannot exceed ${MAX_OBSERVATION_SLOTS}`,
    );
  }
  const checkByName = new Map<string, TrustedCheck>();
  if (scenario) {
    const checks = trustedChecks(scenario);
    if (checks.length !== bindings.observationContracts.length) {
      fail(
        "bindings.observationContracts",
        "must correspond one-to-one with authored trusted final checks",
      );
    }
    for (const [index, check] of checks.entries()) {
      const name = requireNonEmptyString(
        check.name,
        `scenario.finalChecks[${index}].name`,
      );
      if (checkByName.has(name)) {
        fail(
          "scenario.finalChecks",
          `contains duplicate trusted check name "${name}"`,
        );
      }
      checkByName.set(name, check);
    }
  }
  const contractIds = new Set<string>();
  const contractObserverIds = new Set<string>();
  const connectorsWithContracts = new Set<string>();
  let hasProviderBoundary = false;
  for (const [index, contract] of bindings.observationContracts.entries()) {
    validateContractFields(contract, index);
    validateContractBase(contract, index, connectors);
    const boundConnectorKey = connectorKey(
      contract.connectorProvider,
      contract.accountRefSha256,
      contract.connectionRefSha256,
    );
    connectorsWithContracts.add(boundConnectorKey);
    if (contractIds.has(contract.contractId)) {
      fail(
        `bindings.observationContracts[${index}].contractId`,
        "is duplicated",
      );
    }
    contractIds.add(contract.contractId);
    contractObserverIds.add(contract.observerId);
    if (scenario) {
      const check = checkByName.get(contract.contractId);
      if (!check) {
        fail(
          `bindings.observationContracts[${index}]`,
          "has no authored trusted final check",
        );
      }
      contractMatchesCheck(
        contract,
        check,
        `bindings.observationContracts[${index}]`,
      );
    }
    if (contract.kind === "provider-effect") {
      if (
        !capabilityNames.has(`${boundConnectorKey}\u0000${contract.operation}`)
      ) {
        fail(
          `bindings.observationContracts[${index}].operation`,
          "must name a bound connector capability",
        );
      }
      hasProviderBoundary = true;
    } else if (contract.kind === "provider-no-effect") {
      for (const effectKind of contract.effectKinds) {
        if (!capabilityNames.has(`${boundConnectorKey}\u0000${effectKind}`)) {
          fail(
            `bindings.observationContracts[${index}].effectKinds`,
            `contains unbound capability "${effectKind}"`,
          );
        }
      }
      hasProviderBoundary = true;
    }
  }
  if (!hasProviderBoundary) {
    fail(
      "bindings.observationContracts",
      "must include provider-effect or provider-no-effect proof",
    );
  }
  const targetContract =
    PROVIDER_OPERATION_CONTRACT_BY_KIND[bindings.target.operation.kind];
  const matchingTargetContracts = bindings.observationContracts.filter(
    (contract) => {
      if (
        contract.kind !== "provider-effect" &&
        contract.kind !== "provider-no-effect"
      ) {
        return false;
      }
      return (
        contract.provider === targetContract.provider &&
        contract.connectorProvider === targetContract.connectorProvider &&
        (contract.kind === "provider-effect"
          ? contract.operation === targetContract.operation
          : contract.effectKinds.includes(targetContract.operation))
      );
    },
  );
  if (matchingTargetContracts.length !== 1) {
    fail(
      "bindings.target.operation",
      "must match exactly one provider-effect or provider-no-effect observation contract",
    );
  }
  if (
    contractObserverIds.size !== observerSignerById.size ||
    [...contractObserverIds].some(
      (observerId) => !observerSignerById.has(observerId),
    )
  ) {
    fail(
      "bindings.trust.observerSigners",
      "must bind exactly the observer identities named by observation contracts",
    );
  }
  for (const key of connectors.keys()) {
    if (!connectorsWithCapabilities.has(key)) {
      fail("bindings.connectors", "contains a connector without a capability");
    }
    if (!connectorsWithContracts.has(key)) {
      fail(
        "bindings.connectors",
        "contains a connector without an observation contract",
      );
    }
  }
}

function semanticCriteria(
  scenario: ScenarioDefinition,
): ProviderQualificationManifest["scenario"]["semanticCriteria"] {
  const criteria: Array<{
    criterionId: string;
    rubricSha256: string;
    minimumScore: number;
  }> = [];
  for (const [index, turn] of scenario.turns.entries()) {
    if (turn.responseJudge) {
      criteria.push({
        criterionId: `turn:${index}:${turn.name}`,
        rubricSha256: canonicalSha256(
          turn.responseJudge.rubric,
          `scenario.turns[${index}].responseJudge.rubric`,
        ),
        minimumScore: turn.responseJudge.minimumScore ?? 0.8,
      });
    }
  }
  for (const [index, check] of (scenario.finalChecks ?? []).entries()) {
    if (check.type === "judgeRubric") {
      criteria.push({
        criterionId: `final:${index}:${check.name}`,
        rubricSha256: canonicalSha256(
          check.rubric,
          `scenario.finalChecks[${index}].rubric`,
        ),
        minimumScore: check.minimumScore ?? 0.8,
      });
    }
  }
  if (criteria.length === 0) {
    fail(
      "scenario",
      "must declare at least one responseJudge or judgeRubric semantic criterion",
    );
  }
  const ids = new Set<string>();
  for (const [index, criterion] of criteria.entries()) {
    if (ids.has(criterion.criterionId)) {
      fail(`scenario.semanticCriteria[${index}].criterionId`, "is duplicated");
    }
    ids.add(criterion.criterionId);
    if (
      !Number.isFinite(criterion.minimumScore) ||
      criterion.minimumScore < 0 ||
      criterion.minimumScore > 1
    ) {
      fail(
        `scenario.semanticCriteria[${index}].minimumScore`,
        "must be between 0 and 1",
      );
    }
  }
  return [
    criteria[0] as {
      criterionId: string;
      rubricSha256: string;
      minimumScore: number;
    },
    ...criteria.slice(1),
  ];
}

function validateManifestScenario(
  scenario: ProviderQualificationManifest["scenario"],
  observationContracts: ProviderQualificationManifest["requiredObservations"],
): void {
  requireExactKeys(scenario, "manifest.scenario", [
    "id",
    "definitionSha256",
    "finalChecks",
    "semanticCriteria",
  ]);
  requireNonEmptyString(scenario.id, "manifest.scenario.id");
  requireSha256(
    scenario.definitionSha256,
    "manifest.scenario.definitionSha256",
  );
  if (
    !Array.isArray(scenario.finalChecks) ||
    scenario.finalChecks.length === 0
  ) {
    fail("manifest.scenario.finalChecks", "must be a non-empty exact list");
  }
  if (scenario.finalChecks.length > MAX_MANIFEST_FINAL_CHECKS) {
    fail(
      "manifest.scenario.finalChecks",
      `cannot exceed ${MAX_MANIFEST_FINAL_CHECKS}`,
    );
  }

  const trustedCheckByName = new Map<
    string,
    { type: TrustedCheckType; index: number }
  >();
  const semanticFinalChecks = new Map<number, string>();
  const finalCheckIds = new Set<string>();
  for (const [index, check] of scenario.finalChecks.entries()) {
    const path = `manifest.scenario.finalChecks[${index}]`;
    requireExactKeys(check, path, ["checkId", "type", "definitionSha256"]);
    const type = requireNonEmptyString(check.type, `${path}.type`);
    const checkId = requireNonEmptyString(check.checkId, `${path}.checkId`);
    requireSha256(check.definitionSha256, `${path}.definitionSha256`);
    const prefix = `${index}:${type}:`;
    if (!checkId.startsWith(prefix)) {
      fail(
        `${path}.checkId`,
        `must use the canonical "${prefix}<name>" identity`,
      );
    }
    if (finalCheckIds.has(checkId)) {
      fail(`${path}.checkId`, "is duplicated");
    }
    finalCheckIds.add(checkId);
    const name = checkId.slice(prefix.length);
    if (type === "judgeRubric") {
      requireNonEmptyString(name, `${path}.checkId name`);
      semanticFinalChecks.set(index, name);
      continue;
    }
    if (!Object.hasOwn(TRUSTED_CHECK_KIND, type)) {
      fail(`${path}.type`, "must be a trusted observer or semantic check");
    }
    requireNonEmptyString(name, `${path}.checkId name`);
    if (trustedCheckByName.has(name)) {
      fail(`${path}.checkId`, `duplicates trusted check name "${name}"`);
    }
    trustedCheckByName.set(name, {
      type: type as TrustedCheckType,
      index,
    });
  }

  if (trustedCheckByName.size !== observationContracts.length) {
    fail(
      "manifest.scenario.finalChecks",
      "must correspond one-to-one with required observation contracts",
    );
  }
  for (const [index, contract] of observationContracts.entries()) {
    const check = trustedCheckByName.get(contract.contractId);
    if (!check) {
      fail(
        `manifest.requiredObservations[${index}]`,
        "has no canonical trusted final-check identity",
      );
    }
    if (TRUSTED_CHECK_KIND[check.type] !== contract.kind) {
      fail(
        `manifest.requiredObservations[${index}].kind`,
        `does not match final check ${check.type}`,
      );
    }
  }

  if (
    !Array.isArray(scenario.semanticCriteria) ||
    scenario.semanticCriteria.length === 0
  ) {
    fail(
      "manifest.scenario.semanticCriteria",
      "must contain at least one semantic criterion",
    );
  }
  if (scenario.semanticCriteria.length > MAX_SEMANTIC_CRITERIA) {
    fail(
      "manifest.scenario.semanticCriteria",
      `cannot exceed ${MAX_SEMANTIC_CRITERIA}`,
    );
  }
  const criterionIds = new Set<string>();
  const semanticFinalIndexes = new Set<number>();
  const semanticTurnIndexes = new Set<number>();
  for (const [index, criterion] of scenario.semanticCriteria.entries()) {
    const path = `manifest.scenario.semanticCriteria[${index}]`;
    requireExactKeys(criterion, path, [
      "criterionId",
      "rubricSha256",
      "minimumScore",
    ]);
    const criterionId = requireNonEmptyString(
      criterion.criterionId,
      `${path}.criterionId`,
    );
    requireSha256(criterion.rubricSha256, `${path}.rubricSha256`);
    if (
      typeof criterion.minimumScore !== "number" ||
      !Number.isFinite(criterion.minimumScore) ||
      criterion.minimumScore < 0 ||
      criterion.minimumScore > 1
    ) {
      fail(`${path}.minimumScore`, "must be between 0 and 1");
    }
    if (criterionIds.has(criterionId)) {
      fail(`${path}.criterionId`, "is duplicated");
    }
    criterionIds.add(criterionId);
    const match = /^(turn|final):(\d+):(.+)$/.exec(criterionId);
    if (!match) {
      fail(
        `${path}.criterionId`,
        'must use the canonical "turn:<index>:<name>" or "final:<index>:<name>" identity',
      );
    }
    const sourceIndex = Number(match[2]);
    if (!Number.isSafeInteger(sourceIndex)) {
      fail(`${path}.criterionId`, "contains an unsafe source index");
    }
    if (match[1] === "turn") {
      if (semanticTurnIndexes.has(sourceIndex)) {
        fail(`${path}.criterionId`, "duplicates a turn semantic criterion");
      }
      semanticTurnIndexes.add(sourceIndex);
      continue;
    }
    if (
      semanticFinalChecks.get(sourceIndex) !== match[3] ||
      semanticFinalIndexes.has(sourceIndex)
    ) {
      fail(
        `${path}.criterionId`,
        "does not match exactly one judgeRubric final check",
      );
    }
    semanticFinalIndexes.add(sourceIndex);
  }
  if (
    semanticFinalIndexes.size !== semanticFinalChecks.size ||
    [...semanticFinalChecks.keys()].some(
      (index) => !semanticFinalIndexes.has(index),
    )
  ) {
    fail(
      "manifest.scenario.semanticCriteria",
      "must include every judgeRubric final check exactly once",
    );
  }
}

/**
 * Validate and freeze a manifest received across a process boundary.
 *
 * Construction and qualification both call this validator so a correctly
 * signed hand-built object cannot bypass the builder's closed protocol.
 */
export function validateProviderQualificationManifest(
  value: unknown,
): ProviderQualificationManifest {
  const snapshot = canonicalJsonValue(
    value,
    "manifest",
  ) as unknown as ProviderQualificationManifest;
  requireExactKeys(snapshot, "manifest", [
    "schema",
    "manifestSha256",
    "scenario",
    "run",
    "trust",
    "target",
    "models",
    "connectors",
    "ingress",
    "capabilities",
    "requiredObservations",
  ]);
  if (snapshot.schema !== PROVIDER_QUALIFICATION_MANIFEST_SCHEMA) {
    fail("manifest.schema", "is unsupported");
  }
  requireSha256(snapshot.manifestSha256, "manifest.manifestSha256");
  requireExactKeys(snapshot.run, "manifest.run", [
    "runId",
    "nonce",
    "repositorySha",
    "deploymentSha",
  ]);

  const bindings = providerRunBindingsFromManifest(snapshot);
  validateBindings(bindings);
  validateManifestScenario(snapshot.scenario, snapshot.requiredObservations);

  const { manifestSha256, ...core } = snapshot;
  if (canonicalSha256(core, "manifest") !== manifestSha256) {
    fail("manifest.manifestSha256", "does not match the canonical manifest");
  }
  return snapshot;
}

function providerRunBindingsFromManifest(
  manifest: ProviderQualificationManifest,
): ProviderRunBindings {
  return {
    runId: manifest.run.runId,
    runNonce: manifest.run.nonce,
    repositorySha: manifest.run.repositorySha,
    deploymentSha: manifest.run.deploymentSha,
    trust: manifest.trust,
    target: manifest.target,
    models: manifest.models,
    connectors: manifest.connectors,
    ingress: manifest.ingress,
    capabilities: manifest.capabilities,
    observationContracts: manifest.requiredObservations,
  } satisfies ProviderRunBindings;
}

/**
 * Validate a manifest against the exact authored scenario used for execution.
 *
 * Rebuilding through the public constructor keeps every scenario, binding,
 * final-check, and semantic-criterion invariant identical at both boundaries.
 */
export function validateProviderQualificationManifestForScenario(
  value: unknown,
  scenario: ScenarioDefinition,
): ProviderQualificationManifest {
  const manifest = validateProviderQualificationManifest(value);
  const rebuilt = createProviderQualificationManifest({
    scenario,
    bindings: providerRunBindingsFromManifest(manifest),
  });
  if (
    canonicalJson(
      canonicalJsonValue(rebuilt, "rebuiltProviderQualificationManifest"),
    ) !==
    canonicalJson(canonicalJsonValue(manifest, "providerQualificationManifest"))
  ) {
    fail(
      "manifest",
      "does not exactly match the canonical manifest rebuilt from the authored scenario",
    );
  }
  return manifest;
}

/**
 * Create and hash one closed provider-qualified run manifest.
 *
 * The function rejects every executable or harness-controlled scenario path;
 * callers cannot retrofit provider status onto an existing simulated run.
 */
export function createProviderQualificationManifest(input: {
  scenario: ScenarioDefinition;
  bindings: ProviderRunBindings;
}): ProviderQualificationManifest {
  const snapshot = canonicalJsonValue(input, "input") as unknown as {
    scenario: ScenarioDefinition;
    bindings: ProviderRunBindings;
  };
  requireExactKeys(snapshot, "input", ["scenario", "bindings"]);
  const { scenario, bindings } = snapshot;
  validateScenarioShape(scenario);
  validateBindings(bindings, scenario);

  const finalChecks = (scenario.finalChecks ?? []).map((check, index) => ({
    checkId: `${index}:${check.type}:${check.name ?? ""}`,
    type: check.type,
    definitionSha256: canonicalSha256(check, `scenario.finalChecks[${index}]`),
  }));
  const core = {
    schema: PROVIDER_QUALIFICATION_MANIFEST_SCHEMA,
    scenario: {
      id: scenario.id,
      definitionSha256: canonicalSha256(scenario, "scenario"),
      finalChecks,
      semanticCriteria: semanticCriteria(scenario),
    },
    run: {
      runId: bindings.runId,
      nonce: bindings.runNonce,
      repositorySha: bindings.repositorySha,
      deploymentSha: bindings.deploymentSha,
    },
    trust: bindings.trust,
    target: bindings.target,
    models: bindings.models,
    connectors: bindings.connectors,
    ingress: bindings.ingress,
    capabilities: bindings.capabilities,
    requiredObservations: bindings.observationContracts,
  } satisfies Omit<ProviderQualificationManifest, "manifestSha256">;
  const manifestSha256 = canonicalSha256(core, "manifest");
  return validateProviderQualificationManifest({
    ...core,
    manifestSha256,
  });
}
