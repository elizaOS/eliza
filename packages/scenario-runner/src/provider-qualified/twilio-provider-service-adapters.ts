/**
 * Adapts production Twilio SMS and voice canaries to authenticated controller,
 * independent observer, and cleanup service roles. The adapter consumes only
 * manifest-authorized material and requires deployed ingress, trajectory,
 * replay, failure-probe, provider callback, REST readback, and durable cleanup
 * collaborators; it never substitutes a local success receipt.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import type { ScenarioReport } from "../types.ts";
import {
  DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA,
  type ProviderBridgeCorrelation,
  type ProviderCleanupProofPayload,
  type ProviderControllerExecutionResult,
} from "./controller-orchestrator-bridge.ts";
import {
  type DeployedCanaryCapabilities,
  type DeployedCanaryCleanupReceipt,
  type DeployedCanaryExecutionBinding,
  type DeployedCanaryFailureProbeReceipt,
  type DeployedCanaryIngressReceipt,
  type DeployedCanaryReplayReceipt,
  type DeployedCanaryTrajectoryMaterial,
  executeDeployedCanaryContract,
} from "./deployed-capability-contract.ts";
import {
  type CanonicalJsonValue,
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
  type ProviderFailureProbeContract,
} from "./manifest.ts";
import type {
  ProviderCanaryAuthorization,
  ProviderFailureProbeHashBinding,
  ProviderFailureProbeMaterial,
} from "./operator-authorization.ts";
import type {
  ProviderCleanupExecutionResult,
  ProviderCleanupServiceAdapter,
  ProviderControllerServiceAdapter,
  ProviderObserverServiceAdapter,
  ProviderServiceAdapterContext,
} from "./provider-service-host.ts";
import type { ProviderObserverEvidencePayload } from "./qualification.ts";
import {
  assertTwilioOperatorCanaryExecutable,
  collectTwilioRawStatusReadback,
  preflightTwilioOperatorCanary,
  type TwilioFetch,
  type TwilioOperatorPlan,
  type TwilioOperatorPreflight,
  type TwilioRawStatusReceipt,
} from "./twilio-operator-controller.ts";

export const TWILIO_STATUS_CALLBACK_SCHEMA =
  "eliza.twilio-provider-canary-status-callback.v1" as const;
export const TWILIO_CLEANUP_REGISTRATION_SCHEMA =
  "eliza.twilio-provider-canary-cleanup-registration.v1" as const;
const PROVIDER_CLEANUP_RESULT_SCHEMA =
  "eliza.provider-canary-cleanup-result.v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACCOUNT_SID_PATTERN = /^AC[a-fA-F0-9]{32}$/;
const MESSAGE_SID_PATTERN = /^SM[a-fA-F0-9]{32}$/;
const CALL_SID_PATTERN = /^CA[a-fA-F0-9]{32}$/;
const AUTH_TOKEN_PATTERN = /^[a-fA-F0-9]{32}$/;
const SESSION_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/;

export interface TwilioAuthorizedMaterial {
  scenario: ScenarioDefinition;
  authorization: ProviderCanaryAuthorization;
  pinnedManifestAuthorityPublicKeysPem: readonly [string, ...string[]];
  providerTarget: unknown;
  operationInput: unknown;
  failureProbes: readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  plan: TwilioOperatorPlan;
}

export interface TwilioAuthorizedMaterialResolver {
  resolve(
    correlation: ProviderBridgeCorrelation,
  ): Promise<TwilioAuthorizedMaterial>;
}

export interface TwilioCredentialGrant {
  accountSid: string;
  authToken: string;
  fromE164: string;
  role: "controller" | "observer" | "cleanup";
}

/** Credentials are resolved inside each independently deployed role. */
export interface TwilioCredentialBoundary {
  resolve(input: {
    accountSid: string;
    fromE164: string;
    channel: "sms" | "voice";
    role: TwilioCredentialGrant["role"];
  }): Promise<TwilioCredentialGrant>;
}

export interface TwilioProductionDelivery {
  ok: boolean;
  status: number | null;
  sid?: string;
  error?: string;
}

/**
 * Structural seam implemented by the production plugin-phone Twilio helpers.
 * Deployments pass sendTwilioSms/sendTwilioVoiceCall through the factory below;
 * no test transport or synthetic SID is provided here.
 */
export interface TwilioProductionDispatchBoundary {
  sendSms(input: {
    credentials: {
      accountSid: string;
      authToken: string;
      fromPhoneNumber: string;
    };
    to: string;
    body: string;
    statusCallbackUrl: string;
    idempotencyKey?: string;
  }): Promise<TwilioProductionDelivery>;
  sendVoiceCall(input: {
    credentials: {
      accountSid: string;
      authToken: string;
      fromPhoneNumber: string;
    };
    to: string;
    message: string;
    statusCallbackUrl: string;
    idempotencyKey?: string;
  }): Promise<TwilioProductionDelivery>;
}

export function createPluginPhoneTwilioDispatchBoundary(input: {
  sendTwilioSms: TwilioProductionDispatchBoundary["sendSms"];
  sendTwilioVoiceCall: TwilioProductionDispatchBoundary["sendVoiceCall"];
}): TwilioProductionDispatchBoundary {
  if (
    typeof input.sendTwilioSms !== "function" ||
    typeof input.sendTwilioVoiceCall !== "function"
  ) {
    fail("production plugin-phone Twilio dispatch functions are required");
  }
  return Object.freeze({
    sendSms: input.sendTwilioSms,
    sendVoiceCall: input.sendTwilioVoiceCall,
  });
}

export interface TwilioRawStatusCallback {
  requestUrl: string;
  rawFormBody: string;
  twilioSignature: string;
  receivedAtIso: string;
}

export interface TwilioStatusCallbackReceipt {
  schema: typeof TWILIO_STATUS_CALLBACK_SCHEMA;
  receivedAtIso: string;
  requestUrl: string;
  accountSid: string;
  resourceSid: string;
  fromE164: string;
  toE164: string;
  status: "delivered" | "completed";
  rawFormSha256: string;
  signatureValidated: true;
  qualificationClaimed: false;
}

export interface TwilioDeployedRuntimeBoundary {
  acceptAuthenticatedIngress(input: {
    correlation: ProviderBridgeCorrelation;
    binding: DeployedCanaryExecutionBinding;
    providerTarget: CanonicalJsonValue;
    operationInput: CanonicalJsonValue;
  }): Promise<{
    sessionId: string;
    receipt: DeployedCanaryIngressReceipt;
  }>;
  completeProviderEffect(input: {
    correlation: ProviderBridgeCorrelation;
    sessionId: string;
    resourceSid: string;
  }): Promise<{
    runnerReport: ScenarioReport;
    statusCallback: TwilioRawStatusCallback;
  }>;
  retrieveTrajectoryMaterial(input: {
    correlation: ProviderBridgeCorrelation;
    sessionId: string;
    binding: DeployedCanaryExecutionBinding;
    correlationId: string;
  }): Promise<DeployedCanaryTrajectoryMaterial>;
  replayAuthenticatedIngress(input: {
    correlation: ProviderBridgeCorrelation;
    sessionId: string;
    binding: DeployedCanaryExecutionBinding;
    correlationId: string;
  }): Promise<DeployedCanaryReplayReceipt>;
  executeFailureProbe(input: {
    correlation: ProviderBridgeCorrelation;
    sessionId: string;
    binding: DeployedCanaryExecutionBinding;
    probe: ProviderFailureProbeHashBinding;
    contract: ProviderFailureProbeContract;
  }): Promise<DeployedCanaryFailureProbeReceipt>;
  cleanupOrReconcile(input: {
    correlation: ProviderBridgeCorrelation;
    sessionId: string;
    binding: DeployedCanaryExecutionBinding;
    correlationId: string;
  }): Promise<DeployedCanaryCleanupReceipt>;
}

export interface TwilioProviderResource {
  schema: typeof TWILIO_CLEANUP_REGISTRATION_SCHEMA;
  scenarioId:
    | "provider.twilio-sms.confirmed-send"
    | "provider.twilio-voice.confirmed-call";
  operationKind: "twilio.sms-send" | "twilio.call-create";
  channel: "sms" | "voice";
  accountSid: string;
  fromE164: string;
  toE164: string;
  idempotencyKeySha256: string;
  resourceSid: string;
  callbackReceiptSha256: string;
  providerReadbackSha256: string;
}

export interface TwilioPlannedProviderResource {
  scenarioId: TwilioProviderResource["scenarioId"];
  operationKind: TwilioProviderResource["operationKind"];
  channel: TwilioProviderResource["channel"];
  accountSid: string;
  fromE164: string;
  toE164: string;
  idempotencyKeySha256: string;
}

/** Registry administration must be independent from the controller role. */
export interface TwilioCleanupRegistry {
  prepare(input: {
    correlation: ProviderBridgeCorrelation;
    planned: TwilioPlannedProviderResource;
  }): Promise<{ cleanupScopeSha256: string }>;
  recordDispatched(input: {
    correlation: ProviderBridgeCorrelation;
    cleanupScopeSha256: string;
    planned: TwilioPlannedProviderResource;
    resourceSid: string;
  }): Promise<void>;
  recordObserved(input: {
    correlation: ProviderBridgeCorrelation;
    cleanupScopeSha256: string;
    resource: TwilioProviderResource;
  }): Promise<void>;
  recordReconciliationRequired(input: {
    correlation: ProviderBridgeCorrelation;
    cleanupScopeSha256: string;
    planned: TwilioPlannedProviderResource;
    resourceSid?: string;
    failureSha256: string;
  }): Promise<void>;
  resolve(input: {
    context: ProviderServiceAdapterContext;
    cleanupScopeSha256: string;
  }): Promise<TwilioProviderResource>;
}

export type TwilioCleanupProviderResult =
  | {
      disposition: "deleted" | "already-absent";
      resourceKind: "message" | "call";
      resourceSid: string;
    }
  | {
      disposition: "reconciliation-required";
      resourceKind: "message" | "call";
      resourceSid: string;
      reason: string;
    };

export interface TwilioCleanupProviderBoundary {
  cleanupResource(input: {
    credentials: {
      accountSid: string;
      authToken: string;
      fromPhoneNumber: string;
    };
    resourceKind: "message" | "call";
    resourceSid: string;
  }): Promise<TwilioCleanupProviderResult>;
}

/** Adapt the production plugin-phone cleanup helper without retaining secrets. */
export function createPluginPhoneTwilioCleanupBoundary(input: {
  cleanupTwilioProviderResource: TwilioCleanupProviderBoundary["cleanupResource"];
}): TwilioCleanupProviderBoundary {
  if (typeof input.cleanupTwilioProviderResource !== "function") {
    fail("production plugin-phone Twilio cleanup function is required");
  }
  return Object.freeze({
    cleanupResource: input.cleanupTwilioProviderResource,
  });
}

export interface TwilioObserverBoundary {
  begin(input: {
    context: ProviderServiceAdapterContext;
    material: TwilioAuthorizedMaterial;
    correlation: ProviderBridgeCorrelation;
  }): Promise<unknown>;
  complete(input: {
    context: ProviderServiceAdapterContext;
    request: unknown;
    material: TwilioAuthorizedMaterial;
    readback: TwilioRawStatusReceipt;
  }): Promise<unknown>;
  validateEvidence(input: {
    context: ProviderServiceAdapterContext;
    payload: ProviderObserverEvidencePayload;
    payloadSha256: string;
    completedMaterialSha256: string;
    expectedValidationSha256: string;
    deploymentAttestationSha256: string;
  }): Promise<{
    validationSha256: string;
    deploymentAttestationSha256: string;
  }>;
  validateCleanup(input: {
    context: ProviderServiceAdapterContext;
    cleanupResult: ProviderCleanupExecutionResult;
    cleanupResultSha256: string;
    expectedValidationSha256: string;
  }): Promise<{
    validationSha256: string;
    payload: ProviderCleanupProofPayload;
  }>;
}

function fail(message: string): never {
  throw new Error(`twilio provider service adapter ${message}`);
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value))
    fail(`${path} must be a lowercase SHA-256 digest`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${path} must be a non-empty string`);
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    fail(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0)
    fail(`${path} violates its closed shape`);
}

function requireCorrelation(
  context: ProviderServiceAdapterContext,
  value: unknown,
): ProviderBridgeCorrelation {
  const correlation = record(value, "correlation");
  exact(
    correlation,
    [
      "scenarioId",
      "operationKind",
      "controllerFamily",
      "runId",
      "runNonce",
      "manifestSha256",
      "repositorySha",
      "deploymentSha",
      "targetOperationSha256",
      "failureProbesSha256",
    ],
    "correlation",
  );
  if (
    correlation.controllerFamily !== "twilio" ||
    correlation.scenarioId !== context.scenarioId ||
    correlation.operationKind !== context.operationKind ||
    correlation.runId !== context.runId ||
    correlation.manifestSha256 !== context.manifestSha256 ||
    correlation.repositorySha !== context.repositorySha ||
    correlation.deploymentSha !== context.deploymentSha
  )
    fail("correlation does not match the authenticated service context");
  hash(correlation.targetOperationSha256, "correlation.targetOperationSha256");
  hash(correlation.failureProbesSha256, "correlation.failureProbesSha256");
  return canonicalJsonValue(
    correlation,
    "twilioProviderCorrelation",
  ) as unknown as ProviderBridgeCorrelation;
}

function validateMaterial(
  correlation: ProviderBridgeCorrelation,
  material: TwilioAuthorizedMaterial,
): TwilioOperatorPreflight {
  const preflight = preflightTwilioOperatorCanary(material);
  const manifest = preflight.authorization.manifest;
  if (
    preflight.scenarioId !== correlation.scenarioId ||
    preflight.execution.targetBinding.kind !== correlation.operationKind ||
    manifest.run.runId !== correlation.runId ||
    manifest.run.nonce !== correlation.runNonce ||
    manifest.manifestSha256 !== correlation.manifestSha256 ||
    manifest.run.repositorySha !== correlation.repositorySha ||
    manifest.run.deploymentSha !== correlation.deploymentSha ||
    canonicalSha256(manifest.target.operation, "twilioTargetOperation") !==
      correlation.targetOperationSha256 ||
    canonicalSha256(manifest.requiredFailureProbes, "twilioFailureProbes") !==
      correlation.failureProbesSha256
  )
    fail("resolved signed material does not match the request correlation");
  return preflight;
}

function exactJson(actual: unknown, expected: unknown, path: string): void {
  if (
    canonicalJson(canonicalJsonValue(actual, path)) !==
    canonicalJson(canonicalJsonValue(expected, path))
  )
    fail(`${path} differs from the authorized prepared material`);
}

function requireCredential(
  grant: TwilioCredentialGrant,
  preflight: TwilioOperatorPreflight,
  role: TwilioCredentialGrant["role"],
): TwilioCredentialGrant {
  if (
    grant.role !== role ||
    grant.accountSid !== preflight.plan.accountSid ||
    grant.fromE164 !== preflight.plan.fromE164 ||
    !ACCOUNT_SID_PATTERN.test(grant.accountSid) ||
    !AUTH_TOKEN_PATTERN.test(grant.authToken)
  )
    fail(`${role} credential grant does not match the signed Twilio plan`);
  return grant;
}

function signaturePayload(url: string, params: URLSearchParams): string {
  const entries = [...params.entries()];
  const names = new Set(entries.map(([name]) => name));
  if (names.size !== entries.length)
    fail("status callback has duplicate fields");
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${url}${entries.map(([name, value]) => `${name}${value}`).join("")}`;
}

/** Verify a provider-signed terminal status callback against the signed route. */
export function collectTwilioStatusCallback(input: {
  preflight: TwilioOperatorPreflight;
  resourceSid: string;
  authToken: string;
  callback: TwilioRawStatusCallback;
}): TwilioStatusCallbackReceipt {
  const { plan } = input.preflight;
  if (input.callback.requestUrl !== plan.statusCallbackUrl)
    fail("status callback URL is not the manifest-bound Twilio ingress URL");
  const receivedAt = Date.parse(input.callback.receivedAtIso);
  if (!Number.isFinite(receivedAt)) fail("status callback time is invalid");
  if (!AUTH_TOKEN_PATTERN.test(input.authToken))
    fail("status callback credential is invalid");
  const params = new URLSearchParams(input.callback.rawFormBody);
  const expected = createHmac("sha1", input.authToken)
    .update(signaturePayload(input.callback.requestUrl, params))
    .digest();
  const supplied = Buffer.from(input.callback.twilioSignature, "base64");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    fail("status callback signature is invalid");
  const sidField = plan.channel === "sms" ? "MessageSid" : "CallSid";
  const statusField = plan.channel === "sms" ? "MessageStatus" : "CallStatus";
  const resourceSid = string(params.get(sidField), `callback.${sidField}`);
  const status = string(params.get(statusField), `callback.${statusField}`);
  if (
    params.get("AccountSid") !== plan.accountSid ||
    resourceSid !== input.resourceSid ||
    !(plan.channel === "sms" ? MESSAGE_SID_PATTERN : CALL_SID_PATTERN).test(
      resourceSid,
    ) ||
    params.get("From") !== plan.fromE164 ||
    params.get("To") !== plan.toE164 ||
    status !== (plan.channel === "sms" ? "delivered" : "completed")
  )
    fail("status callback does not prove the exact terminal Twilio effect");
  return Object.freeze({
    schema: TWILIO_STATUS_CALLBACK_SCHEMA,
    receivedAtIso: new Date(receivedAt).toISOString(),
    requestUrl: input.callback.requestUrl,
    accountSid: plan.accountSid,
    resourceSid,
    fromE164: plan.fromE164,
    toE164: plan.toE164,
    status: plan.channel === "sms" ? "delivered" : "completed",
    rawFormSha256: createHash("sha256")
      .update(input.callback.rawFormBody)
      .digest("hex"),
    signatureValidated: true,
    qualificationClaimed: false,
  });
}

async function dispatch(input: {
  preflight: TwilioOperatorPreflight;
  credential: TwilioCredentialGrant;
  service: TwilioProductionDispatchBoundary;
}): Promise<string> {
  const { plan } = input.preflight;
  const credentials = {
    accountSid: input.credential.accountSid,
    authToken: input.credential.authToken,
    fromPhoneNumber: input.credential.fromE164,
  };
  const result =
    plan.channel === "sms"
      ? await input.service.sendSms({
          credentials,
          to: plan.toE164,
          body: plan.expectedPayload,
          statusCallbackUrl: plan.statusCallbackUrl,
          idempotencyKey: plan.idempotencyKey,
        })
      : await input.service.sendVoiceCall({
          credentials,
          to: plan.toE164,
          message: plan.expectedPayload,
          statusCallbackUrl: plan.statusCallbackUrl,
          idempotencyKey: plan.idempotencyKey,
        });
  const sidPattern =
    plan.channel === "sms" ? MESSAGE_SID_PATTERN : CALL_SID_PATTERN;
  if (!result.ok || !result.sid || !sidPattern.test(result.sid))
    fail(
      `production Twilio dispatch did not return a provider SID (HTTP ${result.status})`,
    );
  return result.sid;
}

/** Create the authenticated controller adapter; every external seam is mandatory. */
export function createTwilioControllerServiceAdapter(input: {
  materials: TwilioAuthorizedMaterialResolver;
  credential: TwilioCredentialBoundary;
  service: TwilioProductionDispatchBoundary;
  deployed: TwilioDeployedRuntimeBoundary;
  cleanupRegistry: TwilioCleanupRegistry;
  fetchImpl?: TwilioFetch;
  now?: () => Date;
}): ProviderControllerServiceAdapter {
  return Object.freeze({
    async execute(
      context: ProviderServiceAdapterContext,
      payload: unknown,
    ): Promise<ProviderControllerExecutionResult> {
      const request = record(payload, "controller payload");
      exact(
        request,
        ["correlation", "providerTarget", "operationInput", "failureProbes"],
        "controller payload",
      );
      const correlation = requireCorrelation(context, request.correlation);
      const material = await input.materials.resolve(correlation);
      exactJson(
        request.providerTarget,
        material.providerTarget,
        "provider target",
      );
      exactJson(
        request.operationInput,
        material.operationInput,
        "operation input",
      );
      exactJson(
        request.failureProbes,
        material.failureProbes,
        "failure probes",
      );
      const preflight = validateMaterial(correlation, material);
      const credential = requireCredential(
        await input.credential.resolve({
          accountSid: preflight.plan.accountSid,
          fromE164: preflight.plan.fromE164,
          channel: preflight.plan.channel,
          role: "controller",
        }),
        preflight,
        "controller",
      );
      let sessionId: string | undefined;
      let resourceSid: string | undefined;
      let runnerReport: ScenarioReport | undefined;
      let providerReadback: TwilioRawStatusReceipt | undefined;
      let cleanupScopeSha256: string | undefined;
      const planned = Object.freeze({
        scenarioId: preflight.scenarioId,
        operationKind:
          preflight.plan.channel === "sms"
            ? "twilio.sms-send"
            : "twilio.call-create",
        channel: preflight.plan.channel,
        accountSid: preflight.plan.accountSid,
        fromE164: preflight.plan.fromE164,
        toE164: preflight.plan.toE164,
        idempotencyKeySha256: createHash("sha256")
          .update(preflight.plan.idempotencyKey)
          .digest("hex"),
      }) satisfies TwilioPlannedProviderResource;
      const capabilities: DeployedCanaryCapabilities = {
        authenticateIngress: async (binding) => {
          const accepted = await input.deployed.acceptAuthenticatedIngress({
            correlation,
            binding,
            providerTarget: canonicalJsonValue(
              material.providerTarget,
              "twilioProviderTarget",
            ),
            operationInput: canonicalJsonValue(
              material.operationInput,
              "twilioOperationInput",
            ),
          });
          if (!SESSION_PATTERN.test(accepted.sessionId))
            fail("deployed ingress returned an invalid session identifier");
          sessionId = accepted.sessionId;
          const preparation = await input.cleanupRegistry.prepare({
            correlation,
            planned,
          });
          const preparedCleanupScopeSha256 = hash(
            preparation.cleanupScopeSha256,
            "cleanup preparation digest",
          );
          cleanupScopeSha256 = preparedCleanupScopeSha256;
          try {
            resourceSid = await dispatch({
              preflight,
              credential,
              service: input.service,
            });
            await input.cleanupRegistry.recordDispatched({
              correlation,
              cleanupScopeSha256: preparedCleanupScopeSha256,
              planned,
              resourceSid,
            });
            const completed = await input.deployed.completeProviderEffect({
              correlation,
              sessionId,
              resourceSid,
            });
            runnerReport = completed.runnerReport;
            const callback = collectTwilioStatusCallback({
              preflight,
              resourceSid,
              authToken: credential.authToken,
              callback: completed.statusCallback,
            });
            providerReadback = await collectTwilioRawStatusReadback({
              preflight,
              resourceSid,
              accountSid: credential.accountSid,
              authToken: credential.authToken,
              ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
              collectedAt: (input.now ?? (() => new Date()))(),
            });
            const resource = Object.freeze({
              schema: TWILIO_CLEANUP_REGISTRATION_SCHEMA,
              ...planned,
              resourceSid,
              callbackReceiptSha256: canonicalSha256(
                callback,
                "twilioStatusCallbackReceipt",
              ),
              providerReadbackSha256: canonicalSha256(
                providerReadback,
                "twilioProviderReadback",
              ),
            }) satisfies TwilioProviderResource;
            await input.cleanupRegistry.recordObserved({
              correlation,
              cleanupScopeSha256: preparedCleanupScopeSha256,
              resource,
            });
          } catch (error) {
            // error-policy:J2 persist ambiguity before the controller boundary rethrows.
            await input.cleanupRegistry.recordReconciliationRequired({
              correlation,
              cleanupScopeSha256: preparedCleanupScopeSha256,
              planned,
              ...(resourceSid ? { resourceSid } : {}),
              failureSha256: canonicalSha256(
                {
                  name:
                    error instanceof Error ? error.name : "NonErrorRejection",
                  message:
                    error instanceof Error
                      ? error.message
                      : "non-error Twilio provider rejection",
                },
                "twilioDispatchReconciliationFailure",
              ),
            });
            throw new Error(
              "twilio provider service adapter provider effect requires reconciliation",
              { cause: error },
            );
          }
          return accepted.receipt;
        },
        retrieveTrajectoryMaterial: ({ binding, correlationId }) => {
          if (!sessionId || !providerReadback)
            fail("provider readback is unavailable before trajectory export");
          return input.deployed.retrieveTrajectoryMaterial({
            correlation,
            sessionId,
            binding,
            correlationId,
          });
        },
        replayAuthenticatedIngress: ({ binding, correlationId }) => {
          if (!sessionId) fail("deployed session is unavailable before replay");
          return input.deployed.replayAuthenticatedIngress({
            correlation,
            sessionId,
            binding,
            correlationId,
          });
        },
        executeFailureProbe: ({ binding, probe, contract }) => {
          if (!sessionId)
            fail("deployed session is unavailable before failure probes");
          return input.deployed.executeFailureProbe({
            correlation,
            sessionId,
            binding,
            probe,
            contract,
          });
        },
        cleanupOrReconcile: ({ binding, correlationId }) => {
          if (!sessionId)
            fail("deployed session is unavailable before reconciliation");
          return input.deployed.cleanupOrReconcile({
            correlation,
            sessionId,
            binding,
            correlationId,
          });
        },
      };
      const executable = assertTwilioOperatorCanaryExecutable(
        preflight,
        capabilities,
      );
      const descriptor = { ...preflight.plan.deploymentEvidence };
      delete (descriptor as { providerStatusReadback?: string })
        .providerStatusReadback;
      const deployedExecution = await executeDeployedCanaryContract({
        descriptor,
        execution: preflight.execution,
        capabilities: executable,
        ingressRequestSha256: context.requestSha256,
        now: input.now,
      });
      if (!runnerReport || !providerReadback || !cleanupScopeSha256)
        fail("controller did not complete every required production boundary");
      return Object.freeze({
        rawControllerMaterial: Object.freeze({
          schema: DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA,
          scenarioId: preflight.scenarioId,
          operationKind: planned.operationKind,
          controllerFamily: "twilio",
          deployedExecution,
          providerReadback,
          qualificationClaimed: false,
        }),
        runnerReport,
        trajectories: deployedExecution.trajectories,
        cleanupScopeSha256,
      });
    },
  });
}

function rawResourceSid(payload: unknown): string {
  const request = record(payload, "observer completion payload");
  const raw = record(request.rawControllerMaterial, "rawControllerMaterial");
  const readback = record(raw.providerReadback, "providerReadback");
  return string(readback.resourceSid, "providerReadback.resourceSid");
}

/** Create an observer which uses its own credential boundary and provider GET. */
export function createTwilioObserverServiceAdapter(input: {
  materials: TwilioAuthorizedMaterialResolver;
  credential: TwilioCredentialBoundary;
  boundary: TwilioObserverBoundary;
  fetchImpl?: TwilioFetch;
  now?: () => Date;
}): ProviderObserverServiceAdapter {
  return Object.freeze({
    async begin(context: ProviderServiceAdapterContext, payload: unknown) {
      const request = record(payload, "observer begin payload");
      exact(request, ["correlation"], "observer begin payload");
      const correlation = requireCorrelation(context, request.correlation);
      const material = await input.materials.resolve(correlation);
      validateMaterial(correlation, material);
      return input.boundary.begin({ context, material, correlation });
    },
    async complete(context: ProviderServiceAdapterContext, payload: unknown) {
      const request = record(payload, "observer completion payload");
      const correlation = requireCorrelation(context, request.correlation);
      const material = await input.materials.resolve(correlation);
      const preflight = validateMaterial(correlation, material);
      const credential = requireCredential(
        await input.credential.resolve({
          accountSid: preflight.plan.accountSid,
          fromE164: preflight.plan.fromE164,
          channel: preflight.plan.channel,
          role: "observer",
        }),
        preflight,
        "observer",
      );
      const readback = await collectTwilioRawStatusReadback({
        preflight,
        resourceSid: rawResourceSid(payload),
        accountSid: credential.accountSid,
        authToken: credential.authToken,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        collectedAt: (input.now ?? (() => new Date()))(),
      });
      return input.boundary.complete({
        context,
        request: payload,
        material,
        readback,
      });
    },
    validateEvidenceForSigning: (
      validation: Parameters<
        ProviderObserverServiceAdapter["validateEvidenceForSigning"]
      >[0],
    ) => input.boundary.validateEvidence(validation),
    validateCleanupForSigning: (
      validation: Parameters<
        ProviderObserverServiceAdapter["validateCleanupForSigning"]
      >[0],
    ) => input.boundary.validateCleanup(validation),
  });
}

function cleanupPayload(value: unknown): {
  correlation: ProviderBridgeCorrelation;
  cleanupScopeSha256: string;
  rawControllerMaterialSha256: string;
  qualificationArtifactSha256?: string;
  completedStages: readonly string[];
  failed: boolean;
} {
  const payload = record(value, "cleanup payload");
  const allowed = new Set([
    "correlation",
    "cleanupScopeSha256",
    "rawControllerMaterialSha256",
    "qualificationArtifactSha256",
    "completedStages",
    "failed",
  ]);
  if (Object.keys(payload).some((key) => !allowed.has(key)))
    fail("cleanup payload has an unsupported shape");
  if (
    !Array.isArray(payload.completedStages) ||
    typeof payload.failed !== "boolean"
  )
    fail("cleanup payload stages or failure state is invalid");
  return {
    correlation: payload.correlation as ProviderBridgeCorrelation,
    cleanupScopeSha256: hash(payload.cleanupScopeSha256, "cleanupScopeSha256"),
    rawControllerMaterialSha256: hash(
      payload.rawControllerMaterialSha256,
      "rawControllerMaterialSha256",
    ),
    ...(payload.qualificationArtifactSha256 === undefined
      ? {}
      : {
          qualificationArtifactSha256: hash(
            payload.qualificationArtifactSha256,
            "qualificationArtifactSha256",
          ),
        }),
    completedStages: payload.completedStages.map((stage, index) =>
      string(stage, `completedStages[${index}]`),
    ),
    failed: payload.failed,
  };
}

/** Delete the exact registered Twilio record with cleanup-only credentials. */
export function createTwilioCleanupServiceAdapter(input: {
  registry: TwilioCleanupRegistry;
  credential: TwilioCredentialBoundary;
  service: TwilioCleanupProviderBoundary;
  now?: () => Date;
}): ProviderCleanupServiceAdapter {
  return Object.freeze({
    async executeCleanup(
      context: ProviderServiceAdapterContext,
      value: unknown,
    ): Promise<ProviderCleanupExecutionResult> {
      const payload = cleanupPayload(value);
      requireCorrelation(context, payload.correlation);
      const resource = await input.registry.resolve({
        context,
        cleanupScopeSha256: payload.cleanupScopeSha256,
      });
      if (
        resource.schema !== TWILIO_CLEANUP_REGISTRATION_SCHEMA ||
        resource.scenarioId !== context.scenarioId ||
        resource.operationKind !== context.operationKind
      )
        fail("cleanup registry returned a cross-scenario resource");
      const credential = await input.credential.resolve({
        accountSid: resource.accountSid,
        fromE164: resource.fromE164,
        channel: resource.channel,
        role: "cleanup",
      });
      if (
        credential.role !== "cleanup" ||
        credential.accountSid !== resource.accountSid ||
        credential.fromE164 !== resource.fromE164 ||
        !AUTH_TOKEN_PATTERN.test(credential.authToken)
      )
        fail("cleanup credential grant does not match the registered resource");
      const cleanup = await input.service.cleanupResource({
        credentials: {
          accountSid: credential.accountSid,
          authToken: credential.authToken,
          fromPhoneNumber: credential.fromE164,
        },
        resourceKind: resource.channel === "sms" ? "message" : "call",
        resourceSid: resource.resourceSid,
      });
      if (
        cleanup.resourceSid !== resource.resourceSid ||
        cleanup.resourceKind !==
          (resource.channel === "sms" ? "message" : "call")
      ) {
        fail(
          "Twilio cleanup result is not correlated to the registered resource",
        );
      }
      if (cleanup.disposition === "reconciliation-required") {
        fail(`Twilio cleanup requires reconciliation: ${cleanup.reason}`);
      }
      const completedAtIso = (input.now ?? (() => new Date()))().toISOString();
      const completedStagesSha256 = canonicalSha256(
        payload.completedStages,
        "providerCleanup.completedStages",
      );
      return Object.freeze({
        schema: PROVIDER_CLEANUP_RESULT_SCHEMA,
        manifestSha256: context.manifestSha256,
        runId: context.runId,
        runNonce: payload.correlation.runNonce,
        scenarioId: context.scenarioId,
        operationKind: context.operationKind,
        cleanupScopeSha256: payload.cleanupScopeSha256,
        rawControllerMaterialSha256: payload.rawControllerMaterialSha256,
        ...(payload.qualificationArtifactSha256 === undefined
          ? {}
          : {
              qualificationArtifactSha256: payload.qualificationArtifactSha256,
            }),
        completedStagesSha256,
        failed: payload.failed,
        disposition: "cleaned",
        completedAtIso,
        cleanupReceiptSha256: canonicalSha256(
          {
            resource,
            completedAtIso,
            cleanupScopeSha256: payload.cleanupScopeSha256,
          },
          "twilioCleanupReceipt",
        ),
      });
    },
  });
}
