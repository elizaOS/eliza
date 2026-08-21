/**
 * Defines the deployment-owned capability boundary used by provider canary
 * controllers. The descriptor is data-only and manifest-bound; injected
 * implementations remain untrusted until every receipt echoes the exact run,
 * request, operation, and failure-probe hashes and trajectory bytes are
 * independently verified from an isolated run directory.
 */

import { createHash } from "node:crypto";
import {
  canonicalSha256,
  type ProviderFailureProbeContract,
} from "./manifest.ts";
import type {
  AuthorizedProviderCanaryExecutionPreflight,
  ProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import {
  type VerifiedScenarioTrajectorySet,
  verifyScenarioTrajectories,
} from "./trajectory-verifier.ts";

export const DEPLOYED_CANARY_CONTRACT_SCHEMA =
  "eliza.provider-canary-deployed-capability-contract.v1" as const;
export const DEPLOYED_CANARY_INGRESS_PATH =
  "/provider-canary/v1/ingress" as const;

export const DEPLOYED_CANARY_CAPABILITIES = Object.freeze([
  "authenticated-ingress",
  "isolated-trajectory-export",
  "authenticated-replay",
  "independent-failure-probes",
  "cleanup-reconciliation",
] as const);

export type DeployedCanaryCapability =
  (typeof DEPLOYED_CANARY_CAPABILITIES)[number];

export interface DeployedCanaryContractDescriptor {
  schema: typeof DEPLOYED_CANARY_CONTRACT_SCHEMA;
  descriptorSha256: string;
  scenarioId: string;
  runId: string;
  deploymentSha256: string;
  ingressEndpoint: string;
  ingressEndpointOriginSha256: string;
  operationBindingSha256: string;
  failureProbeBindingsSha256: string;
  capabilitySet: readonly DeployedCanaryCapability[];
  capabilitySetSha256: string;
  trajectoryEnvironment: string;
  reconciliationOwnerRefSha256: string;
}

export interface DeployedCanaryExecutionBinding {
  descriptorSha256: string;
  scenarioId: string;
  runId: string;
  manifestSha256: string;
  ingressEndpoint: string;
  ingressRequestSha256: string;
  operationBindingSha256: string;
  failureProbeBindingsSha256: string;
}

export interface DeployedCanaryIngressReceipt {
  descriptorSha256: string;
  scenarioId: string;
  runId: string;
  manifestSha256: string;
  ingressEndpointOriginSha256: string;
  ingressRequestSha256: string;
  operationBindingSha256: string;
  authenticationProofSha256: string;
  correlationId: string;
  acceptedAtIso: string;
  authenticated: true;
}

export interface DeployedCanaryTrajectoryMaterial {
  descriptorSha256: string;
  scenarioId: string;
  runId: string;
  correlationId: string;
  runDir: string;
  expectedRelativePaths: readonly string[];
  scenarioStartedAtIso: string;
  scenarioEndedAtIso: string;
  environment: string;
}

export interface DeployedCanaryReplayReceipt {
  descriptorSha256: string;
  scenarioId: string;
  runId: string;
  originalCorrelationId: string;
  replayCorrelationId: string;
  ingressRequestSha256: string;
  operationBindingSha256: string;
  effectCountBefore: number;
  effectCountAfter: number;
  replayObservedAtIso: string;
  authenticated: true;
  noAdditionalEffect: true;
}

export interface DeployedCanaryFailureProbeReceipt
  extends ProviderFailureProbeHashBinding {
  descriptorSha256: string;
  scenarioId: string;
  runId: string;
  failureProbeBindingsSha256: string;
  failureProbeContractSha256: string;
  failureClass: ProviderFailureProbeContract["failureClass"];
  expectedStatusCode: number;
  observedAtIso: string;
  expectedFailureObserved: true;
  providerEffectCountBefore: number;
  providerEffectCountAfter: number;
}

export type DeployedCanaryCleanupReceipt =
  | {
      descriptorSha256: string;
      scenarioId: string;
      runId: string;
      correlationId: string;
      reconciliationOwnerRefSha256: string;
      status: "cleaned";
      completedAtIso: string;
    }
  | {
      descriptorSha256: string;
      scenarioId: string;
      runId: string;
      correlationId: string;
      reconciliationOwnerRefSha256: string;
      status: "reconciliation-required";
      reconciliationRefSha256: string;
      recordedAtIso: string;
    };

export interface DeployedCanaryCapabilities {
  authenticateIngress(
    binding: DeployedCanaryExecutionBinding,
  ): Promise<DeployedCanaryIngressReceipt>;
  retrieveTrajectoryMaterial(input: {
    binding: DeployedCanaryExecutionBinding;
    correlationId: string;
  }): Promise<DeployedCanaryTrajectoryMaterial>;
  replayAuthenticatedIngress(input: {
    binding: DeployedCanaryExecutionBinding;
    correlationId: string;
  }): Promise<DeployedCanaryReplayReceipt>;
  executeFailureProbe(input: {
    binding: DeployedCanaryExecutionBinding;
    probe: ProviderFailureProbeHashBinding;
    contract: ProviderFailureProbeContract;
  }): Promise<DeployedCanaryFailureProbeReceipt>;
  cleanupOrReconcile(input: {
    binding: DeployedCanaryExecutionBinding;
    correlationId: string;
  }): Promise<DeployedCanaryCleanupReceipt>;
}

export interface VerifiedDeployedCanaryExecution {
  binding: DeployedCanaryExecutionBinding;
  ingress: DeployedCanaryIngressReceipt;
  trajectories: VerifiedScenarioTrajectorySet;
  replay: DeployedCanaryReplayReceipt;
  failureProbes: readonly DeployedCanaryFailureProbeReceipt[];
  cleanup: Extract<DeployedCanaryCleanupReceipt, { status: "cleaned" }>;
  qualificationClaimed: false;
}

/** Signals a durable ambiguity record that must stop assembly/publication. */
export class DeployedCanaryReconciliationRequiredError extends Error {
  readonly receipt: Extract<
    DeployedCanaryCleanupReceipt,
    { status: "reconciliation-required" }
  >;

  constructor(
    receipt: Extract<
      DeployedCanaryCleanupReceipt,
      { status: "reconciliation-required" }
    >,
  ) {
    super("deployed provider-canary contract requires reconciliation");
    this.name = "DeployedCanaryReconciliationRequiredError";
    this.receipt = receipt;
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/;
const MAX_RECEIPT_AGE_MS = 30 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

function fail(message: string): never {
  throw new Error(`deployed provider-canary contract ${message}`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function requireIso(value: unknown, path: string): string {
  const iso = requireString(value, path);
  const milliseconds = Date.parse(iso);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== iso
  ) {
    fail(`${path} must be a canonical UTC ISO-8601 timestamp`);
  }
  return iso;
}

function requireCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(`${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requirePlainObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactFunctions(value: unknown): DeployedCanaryCapabilities {
  const capabilities = requirePlainObject(value, "capabilities");
  const expected = [
    "authenticateIngress",
    "retrieveTrajectoryMaterial",
    "replayAuthenticatedIngress",
    "executeFailureProbe",
    "cleanupOrReconcile",
  ] as const;
  const propertyDescriptors = Object.getOwnPropertyDescriptors(capabilities);
  const unknown = Object.keys(propertyDescriptors).filter(
    (key) => !expected.includes(key as (typeof expected)[number]),
  );
  const missing = expected.filter(
    (key) =>
      propertyDescriptors[key] === undefined ||
      typeof propertyDescriptors[key].value !== "function" ||
      propertyDescriptors[key].get !== undefined ||
      propertyDescriptors[key].set !== undefined,
  );
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      `capabilities violate the closed executable shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  return Object.freeze(
    Object.fromEntries(
      expected.map((key) => [key, propertyDescriptors[key]?.value]),
    ),
  ) as unknown as DeployedCanaryCapabilities;
}

function descriptorPayload(
  descriptor: Omit<DeployedCanaryContractDescriptor, "descriptorSha256">,
): Omit<DeployedCanaryContractDescriptor, "descriptorSha256"> {
  return descriptor;
}

/** Construct a self-hashed descriptor whose remaining fields bind to a signed manifest. */
export function createDeployedCanaryContractDescriptor(
  input: Omit<
    DeployedCanaryContractDescriptor,
    "schema" | "descriptorSha256" | "capabilitySet" | "capabilitySetSha256"
  >,
): DeployedCanaryContractDescriptor {
  const capabilitySet = [...DEPLOYED_CANARY_CAPABILITIES];
  const payload = descriptorPayload({
    schema: DEPLOYED_CANARY_CONTRACT_SCHEMA,
    scenarioId: input.scenarioId,
    runId: input.runId,
    deploymentSha256: input.deploymentSha256,
    ingressEndpoint: input.ingressEndpoint,
    ingressEndpointOriginSha256: input.ingressEndpointOriginSha256,
    operationBindingSha256: input.operationBindingSha256,
    failureProbeBindingsSha256: input.failureProbeBindingsSha256,
    capabilitySet,
    capabilitySetSha256: canonicalSha256(capabilitySet, "capabilitySet"),
    trajectoryEnvironment: input.trajectoryEnvironment,
    reconciliationOwnerRefSha256: input.reconciliationOwnerRefSha256,
  });
  return Object.freeze({
    ...payload,
    descriptorSha256: canonicalSha256(payload, "deployedCanaryDescriptor"),
  });
}

/** Validate a descriptor against the exact authorization preflight without network access. */
export function validateDeployedCanaryContractDescriptor(input: {
  descriptor: DeployedCanaryContractDescriptor;
  execution: AuthorizedProviderCanaryExecutionPreflight;
}): DeployedCanaryContractDescriptor {
  const descriptor = requirePlainObject(
    input.descriptor,
    "descriptor",
  ) as unknown as DeployedCanaryContractDescriptor;
  const descriptorKeys = [
    "schema",
    "descriptorSha256",
    "scenarioId",
    "runId",
    "deploymentSha256",
    "ingressEndpoint",
    "ingressEndpointOriginSha256",
    "operationBindingSha256",
    "failureProbeBindingsSha256",
    "capabilitySet",
    "capabilitySetSha256",
    "trajectoryEnvironment",
    "reconciliationOwnerRefSha256",
  ] as const;
  const missing = descriptorKeys.filter(
    (key) => !Object.hasOwn(descriptor, key),
  );
  const unknown = Object.keys(descriptor).filter(
    (key) => !descriptorKeys.includes(key as (typeof descriptorKeys)[number]),
  );
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `descriptor violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  const manifest = input.execution.authorization.manifest;
  if (descriptor.schema !== DEPLOYED_CANARY_CONTRACT_SCHEMA)
    fail("descriptor.schema is unsupported");
  if (
    descriptor.scenarioId !== manifest.scenario.id ||
    descriptor.runId !== manifest.run.runId
  ) {
    fail("descriptor scenario or run does not match the signed manifest");
  }
  if (
    !SOURCE_SHA_PATTERN.test(descriptor.deploymentSha256) ||
    descriptor.deploymentSha256 !== manifest.run.deploymentSha
  ) {
    fail("descriptor deployment does not match the signed manifest");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(descriptor.ingressEndpoint);
  } catch (error) {
    // error-policy:J3 a malformed deployment endpoint is explicit invalid input.
    throw new Error(
      "deployed provider-canary contract descriptor.ingressEndpoint must be a valid URL",
      { cause: error },
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    fail(
      "descriptor.ingressEndpoint must be credential-free HTTPS without a fragment",
    );
  }
  if (
    endpoint.pathname !== DEPLOYED_CANARY_INGRESS_PATH ||
    endpoint.search !== ""
  ) {
    fail(
      `descriptor.ingressEndpoint must use the canonical ${DEPLOYED_CANARY_INGRESS_PATH} path without a query`,
    );
  }
  const originHash = hash(endpoint.origin);
  if (
    requireHash(
      descriptor.ingressEndpointOriginSha256,
      "descriptor.ingressEndpointOriginSha256",
    ) !== originHash ||
    originHash !== manifest.ingress.endpointOriginSha256
  ) {
    fail(
      "descriptor ingress endpoint origin does not match the signed manifest",
    );
  }
  const operationBindingSha256 = canonicalSha256(
    input.execution.targetBinding,
    "operationBinding",
  );
  if (descriptor.operationBindingSha256 !== operationBindingSha256) {
    fail("descriptor operation binding does not match the signed operation");
  }
  const failureProbeBindingsSha256 = canonicalSha256(
    input.execution.failureProbeBindings,
    "failureProbeBindings",
  );
  if (descriptor.failureProbeBindingsSha256 !== failureProbeBindingsSha256) {
    fail(
      "descriptor failure-probe binding set does not match the signed manifest",
    );
  }
  if (
    !Array.isArray(descriptor.capabilitySet) ||
    descriptor.capabilitySet.length !== DEPLOYED_CANARY_CAPABILITIES.length ||
    descriptor.capabilitySet.some(
      (value, index) => value !== DEPLOYED_CANARY_CAPABILITIES[index],
    )
  ) {
    fail(
      "descriptor capabilitySet must contain the complete canonical capability set in order",
    );
  }
  const capabilitySetSha256 = canonicalSha256(
    descriptor.capabilitySet,
    "capabilitySet",
  );
  if (descriptor.capabilitySetSha256 !== capabilitySetSha256) {
    fail("descriptor capabilitySetSha256 is invalid");
  }
  requireString(
    descriptor.trajectoryEnvironment,
    "descriptor.trajectoryEnvironment",
  );
  requireHash(
    descriptor.reconciliationOwnerRefSha256,
    "descriptor.reconciliationOwnerRefSha256",
  );
  const { descriptorSha256: _claimed, ...payload } = descriptor;
  if (
    requireHash(descriptor.descriptorSha256, "descriptor.descriptorSha256") !==
    canonicalSha256(payload, "deployedCanaryDescriptor")
  ) {
    fail("descriptor self-hash is invalid");
  }
  return Object.freeze({
    ...descriptor,
    capabilitySet: Object.freeze([...descriptor.capabilitySet]),
  });
}

/** Assert all executable seams exist before a caller can initiate ingress. */
export function assertDeployedCanaryCapabilities(
  capabilities: unknown,
): DeployedCanaryCapabilities {
  return requireExactFunctions(capabilities);
}

function requireCorrelation(value: unknown, path: string): string {
  const correlationId = requireString(value, path);
  if (!CORRELATION_PATTERN.test(correlationId))
    fail(`${path} has an invalid format`);
  return correlationId;
}

function baseMatches(
  value: Record<string, unknown>,
  binding: DeployedCanaryExecutionBinding,
  path: string,
): void {
  for (const field of ["descriptorSha256", "scenarioId", "runId"] as const) {
    if (value[field] !== binding[field])
      fail(`${path}.${field} does not match the authorized run`);
  }
}

function freshTimestamp(value: unknown, path: string, now: number): number {
  const iso = requireIso(value, path);
  const timestamp = Date.parse(iso);
  if (
    timestamp < now - MAX_RECEIPT_AGE_MS ||
    timestamp > now + MAX_CLOCK_SKEW_MS
  ) {
    fail(`${path} is stale or in the future`);
  }
  return timestamp;
}

/**
 * Execute the deployment contract and verify all returned source material.
 * The result deliberately remains non-qualifying; independent observer
 * signing and artifact assembly occur at the outer qualification boundary.
 */
export async function executeDeployedCanaryContract(input: {
  descriptor: DeployedCanaryContractDescriptor;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  capabilities: DeployedCanaryCapabilities;
  ingressRequestSha256: string;
  now?: () => Date;
}): Promise<VerifiedDeployedCanaryExecution> {
  const descriptor = validateDeployedCanaryContractDescriptor(input);
  const capabilities = assertDeployedCanaryCapabilities(input.capabilities);
  const ingressRequestSha256 = requireHash(
    input.ingressRequestSha256,
    "ingressRequestSha256",
  );
  const manifest = input.execution.authorization.manifest;
  const now = input.now ?? (() => new Date());
  const sampleNow = (): number => {
    const milliseconds = now().getTime();
    if (!Number.isFinite(milliseconds)) fail("now must return a valid Date");
    return milliseconds;
  };
  const binding = Object.freeze({
    descriptorSha256: descriptor.descriptorSha256,
    scenarioId: descriptor.scenarioId,
    runId: descriptor.runId,
    manifestSha256: manifest.manifestSha256,
    ingressEndpoint: descriptor.ingressEndpoint,
    ingressRequestSha256,
    operationBindingSha256: descriptor.operationBindingSha256,
    failureProbeBindingsSha256: descriptor.failureProbeBindingsSha256,
  });
  let correlationId = "pre-ingress";
  let ingressStarted = false;
  let cleanupCompleted = false;
  try {
    ingressStarted = true;
    const ingress = await capabilities.authenticateIngress(binding);
    const ingressRecord = requirePlainObject(ingress, "ingressReceipt");
    baseMatches(ingressRecord, binding, "ingressReceipt");
    if (
      ingress.manifestSha256 !== binding.manifestSha256 ||
      ingress.ingressEndpointOriginSha256 !==
        descriptor.ingressEndpointOriginSha256 ||
      ingress.ingressRequestSha256 !== ingressRequestSha256 ||
      ingress.operationBindingSha256 !== descriptor.operationBindingSha256 ||
      !SHA256_PATTERN.test(ingress.authenticationProofSha256) ||
      ingress.authenticated !== true
    )
      fail(
        "ingress receipt does not bind the exact authenticated request and operation",
      );
    correlationId = requireCorrelation(
      ingress.correlationId,
      "ingressReceipt.correlationId",
    );
    const acceptedAt = freshTimestamp(
      ingress.acceptedAtIso,
      "ingressReceipt.acceptedAtIso",
      sampleNow(),
    );

    const material = await capabilities.retrieveTrajectoryMaterial({
      binding,
      correlationId,
    });
    const materialRecord = requirePlainObject(material, "trajectoryMaterial");
    baseMatches(materialRecord, binding, "trajectoryMaterial");
    if (
      material.correlationId !== correlationId ||
      material.environment !== descriptor.trajectoryEnvironment
    ) {
      fail(
        "trajectory material does not bind the ingress correlation and environment",
      );
    }
    const scenarioStartedAt = Date.parse(
      requireIso(
        material.scenarioStartedAtIso,
        "trajectoryMaterial.scenarioStartedAtIso",
      ),
    );
    const scenarioEndedAt = Date.parse(
      requireIso(
        material.scenarioEndedAtIso,
        "trajectoryMaterial.scenarioEndedAtIso",
      ),
    );
    if (scenarioStartedAt > acceptedAt || scenarioEndedAt < acceptedAt) {
      fail("trajectory interval does not contain the authenticated ingress");
    }
    const trajectories = verifyScenarioTrajectories({
      runDir: material.runDir,
      runId: binding.runId,
      scenarioId: binding.scenarioId,
      scenarioStartedAtIso: material.scenarioStartedAtIso,
      scenarioEndedAtIso: material.scenarioEndedAtIso,
      environment: material.environment,
      expectedRelativePaths: material.expectedRelativePaths,
      now: new Date(sampleNow()),
    });

    const replay = await capabilities.replayAuthenticatedIngress({
      binding,
      correlationId,
    });
    const replayRecord = requirePlainObject(replay, "replayReceipt");
    baseMatches(replayRecord, binding, "replayReceipt");
    if (
      replay.originalCorrelationId !== correlationId ||
      requireCorrelation(
        replay.replayCorrelationId,
        "replayReceipt.replayCorrelationId",
      ) === correlationId ||
      replay.ingressRequestSha256 !== ingressRequestSha256 ||
      replay.operationBindingSha256 !== descriptor.operationBindingSha256 ||
      replay.authenticated !== true ||
      replay.noAdditionalEffect !== true
    )
      fail(
        "replay receipt does not prove correlated authenticated no-effect replay",
      );
    const effectCountBefore = requireCount(
      replay.effectCountBefore,
      "replayReceipt.effectCountBefore",
    );
    const effectCountAfter = requireCount(
      replay.effectCountAfter,
      "replayReceipt.effectCountAfter",
    );
    if (effectCountBefore !== effectCountAfter)
      fail("replay changed the provider effect count");
    const replayObservedAt = freshTimestamp(
      replay.replayObservedAtIso,
      "replayReceipt.replayObservedAtIso",
      sampleNow(),
    );
    if (replayObservedAt < scenarioEndedAt) {
      fail("replay was observed before the original trajectory completed");
    }

    const failureProbes: DeployedCanaryFailureProbeReceipt[] = [];
    let lastObservedAt = replayObservedAt;
    for (const [
      probeIndex,
      probe,
    ] of input.execution.failureProbeBindings.entries()) {
      const contract = manifest.requiredFailureProbes[probeIndex];
      if (!contract || contract.probeId !== probe.probeId) {
        fail(`failure probe ${probe.probeId} has no matching signed contract`);
      }
      const receipt = await capabilities.executeFailureProbe({
        binding,
        probe,
        contract,
      });
      const probeRecord = requirePlainObject(
        receipt,
        `failureProbeReceipt.${probe.probeId}`,
      );
      baseMatches(probeRecord, binding, `failureProbeReceipt.${probe.probeId}`);
      for (const field of [
        "probeId",
        "requestPayloadSha256",
        "expectedErrorCodeSha256",
        "scopeSha256",
        "authorizationGrantSha256",
      ] as const) {
        if (receipt[field] !== probe[field])
          fail(
            `failure probe ${probe.probeId} ${field} does not match the signed probe`,
          );
      }
      if (
        receipt.failureProbeBindingsSha256 !==
          descriptor.failureProbeBindingsSha256 ||
        receipt.failureProbeContractSha256 !==
          canonicalSha256(contract, `failureProbeContract.${probe.probeId}`) ||
        receipt.failureClass !== contract.failureClass ||
        receipt.expectedStatusCode !== contract.expectedStatusCode ||
        receipt.expectedFailureObserved !== true ||
        requireCount(
          receipt.providerEffectCountBefore,
          "failureProbeReceipt.providerEffectCountBefore",
        ) !==
          requireCount(
            receipt.providerEffectCountAfter,
            "failureProbeReceipt.providerEffectCountAfter",
          )
      )
        fail(
          `failure probe ${probe.probeId} did not prove the exact expected no-effect failure`,
        );
      const probeObservedAt = freshTimestamp(
        receipt.observedAtIso,
        "failureProbeReceipt.observedAtIso",
        sampleNow(),
      );
      if (probeObservedAt < lastObservedAt) {
        fail(`failure probe ${probe.probeId} violates receipt chronology`);
      }
      lastObservedAt = probeObservedAt;
      failureProbes.push(Object.freeze({ ...receipt }));
    }

    const cleanup = await capabilities.cleanupOrReconcile({
      binding,
      correlationId,
    });
    const cleanupRecord = requirePlainObject(cleanup, "cleanupReceipt");
    baseMatches(cleanupRecord, binding, "cleanupReceipt");
    if (cleanup.correlationId !== correlationId)
      fail("cleanup receipt does not match the ingress correlation");
    if (
      cleanup.reconciliationOwnerRefSha256 !==
      descriptor.reconciliationOwnerRefSha256
    ) {
      fail("cleanup receipt does not match the bound reconciliation owner");
    }
    if (cleanup.status === "cleaned") {
      const cleanupAt = freshTimestamp(
        cleanup.completedAtIso,
        "cleanupReceipt.completedAtIso",
        sampleNow(),
      );
      if (cleanupAt < lastObservedAt) {
        fail("cleanup violates receipt chronology");
      }
      cleanupCompleted = true;
    } else if (cleanup.status === "reconciliation-required") {
      requireHash(
        cleanup.reconciliationRefSha256,
        "cleanupReceipt.reconciliationRefSha256",
      );
      const recordedAt = freshTimestamp(
        cleanup.recordedAtIso,
        "cleanupReceipt.recordedAtIso",
        sampleNow(),
      );
      if (recordedAt < lastObservedAt) {
        fail("reconciliation record violates receipt chronology");
      }
      cleanupCompleted = true;
      throw new DeployedCanaryReconciliationRequiredError(
        Object.freeze({ ...cleanup }),
      );
    } else {
      fail("cleanup receipt must be cleaned or reconciliation-required");
    }
    return Object.freeze({
      binding,
      ingress: Object.freeze({ ...ingress }),
      trajectories,
      replay: Object.freeze({ ...replay }),
      failureProbes: Object.freeze(failureProbes),
      cleanup: Object.freeze({ ...cleanup }),
      qualificationClaimed: false,
    });
  } catch (error) {
    if (ingressStarted && !cleanupCompleted) {
      try {
        await capabilities.cleanupOrReconcile({ binding, correlationId });
      } catch (cleanupError) {
        // error-policy:J2 a failed reconciliation handoff makes the execution ambiguity explicit.
        throw new AggregateError(
          [error, cleanupError],
          "deployed provider-canary contract execution failed and reconciliation could not be recorded",
        );
      }
    }
    throw error;
  }
}
