/**
 * Exercises the Twilio service-role glue with real manifest signatures and
 * Twilio callback HMACs. Provider I/O remains deterministic; tests assert the
 * bundle refuses unsigned drift, callback tampering, and incomplete cleanup.
 */

import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import smsScenario from "../../../test/scenarios/provider-qualified/provider.twilio-sms.confirmed-send.scenario.ts";
import { createDeployedCanaryContractDescriptor } from "./deployed-capability-contract.ts";
import { canonicalSha256, type ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";
import { preflightTwilioOperatorCanary } from "./twilio-operator-controller.ts";
import {
  collectTwilioStatusCallback,
  createPluginPhoneTwilioCleanupBoundary,
  createPluginPhoneTwilioDispatchBoundary,
  createTwilioCleanupServiceAdapter,
  createTwilioControllerServiceAdapter,
  type TwilioAuthorizedMaterial,
  type TwilioCredentialGrant,
  type TwilioDeployedRuntimeBoundary,
  type TwilioProviderResource,
} from "./twilio-provider-service-adapters.ts";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const accountSid = `AC${"1".repeat(32)}`;
const messageSid = `SM${"2".repeat(32)}`;
const fromE164 = "+15551230001";
const toE164 = "+15551230002";
const authToken = "a".repeat(32);
const runNonce = "n".repeat(64);
const repositorySha = "b".repeat(40);
const deploymentSha = "c".repeat(64);
const body = "Twilio production adapter SMS";
const idempotencyKey = "twilio-adapter-sms-001";
const consent = { grant: "owned-consented-twilio-target", version: 1 };
const consentSha256 = canonicalSha256(consent, "twilioConsent");

const failureMaterials = [
  {
    probeId: "twilio-sms-authorization-denied",
    requestPayload: { denied: true },
    expectedErrorCode: "authentication-failed",
    scope: { accountSid, fromE164, toE164 },
    authorizationGrant: { grant: "denied" },
  },
  {
    probeId: "twilio-sms-provider-rejected",
    requestPayload: { toE164: "+15550000000" },
    expectedErrorCode: "invalid-destination",
    scope: { accountSid, fromE164, toE164 },
    authorizationGrant: consent,
  },
] as const;

function fixture(): TwilioAuthorizedMaterial {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const accountRefSha256 = digest("operator-twilio-canary-account");
  const connectionRefSha256 = digest("twilio-adapter-connection");
  const probeBindings = failureMaterials.map(
    createProviderFailureProbeHashBinding,
  ) as [
    ReturnType<typeof createProviderFailureProbeHashBinding>,
    ReturnType<typeof createProviderFailureProbeHashBinding>,
  ];
  const operation = createProviderCanaryTargetBinding({
    kind: "twilio.sms-send",
    providerTarget: { fromE164, toE164 },
    operationInput: { body, idempotencyKey },
  });
  const bindings: ProviderRunBindings = {
    runId: "twilio-service-adapter-run-001",
    runNonce,
    repositorySha,
    deploymentSha,
    trust: {
      manifestAuthorityKeyId: providerObserverKeyId(publicKey),
      observerSigners: [
        {
          observerId: "twilio-provider-observer",
          keyId: digest("observer-key"),
        },
      ],
    },
    target: {
      principalRefSha256: digest(toE164),
      roomRefSha256: digest(fromE164),
      operation,
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "live-provider",
      actingModel: "live-model",
      judgeProvider: "independent-judge",
      judgeModel: "judge-model",
      judgeKeyId: digest("judge-key"),
    },
    connectors: [
      {
        provider: "twilio",
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: "twilio",
      channel: "sms-webhook",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: digest(toE164),
      roomRefSha256: digest(fromE164),
      endpointOriginSha256: digest("https://agent.example.test"),
    },
    capabilities: [
      {
        provider: "twilio",
        accountRefSha256,
        connectionRefSha256,
        capability: "sms-send",
        authorizationGrantSha256: consentSha256,
      },
    ],
    observationContracts: [
      {
        contractId: "twilio-canary-sms-send",
        kind: "provider-effect",
        observerId: "twilio-provider-observer",
        sourceKind: "provider-api",
        system: "twilio",
        environment: "operator-canary",
        connectorProvider: "twilio",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "twilio",
        operation: "sms-send",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: probeBindings.map((probe, index) => ({
      probeId: probe.probeId,
      observerId: "twilio-provider-observer",
      sourceKind: "provider-api" as const,
      system: "twilio",
      environment: "operator-canary",
      provider: "twilio",
      connectorProvider: "twilio",
      accountRefSha256,
      connectionRefSha256,
      operation: "sms-send",
      failureClass:
        index === 0
          ? ("authorization-denied" as const)
          : ("provider-rejected" as const),
      requestPayloadSha256: probe.requestPayloadSha256,
      expectedStatusCode: index === 0 ? 401 : 400,
      expectedErrorCodeSha256: probe.expectedErrorCodeSha256,
      scopeSha256: probe.scopeSha256,
      authorizationGrantSha256: probe.authorizationGrantSha256,
      maxObservationAgeMs: 60_000,
    })) as unknown as ProviderRunBindings["failureProbes"],
  };
  const authorization = authorizeProviderCanary({
    scenario: smsScenario,
    bindings,
    manifestAuthorityPrivateKey: keys.privateKey,
  });
  const descriptor = createDeployedCanaryContractDescriptor({
    scenarioId: smsScenario.id,
    runId: bindings.runId,
    deploymentSha256: deploymentSha,
    ingressEndpoint: "https://agent.example.test/provider-canary/v1/ingress",
    ingressEndpointOriginSha256: bindings.ingress.endpointOriginSha256,
    operationBindingSha256: canonicalSha256(operation, "operationBinding"),
    failureProbeBindingsSha256: canonicalSha256(
      probeBindings,
      "failureProbeBindings",
    ),
    trajectoryEnvironment: "operator-canary",
    reconciliationOwnerRefSha256: digest("twilio-reconciliation-owner"),
  });
  return {
    scenario: smsScenario as ScenarioDefinition,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: [publicKey],
    providerTarget: { fromE164, toE164 },
    operationInput: { body, idempotencyKey },
    failureProbes: failureMaterials,
    plan: {
      schema: "eliza.twilio-provider-canary-operator-plan.v1",
      twilioApiOrigin: "https://api.twilio.com",
      channel: "sms",
      accountSid,
      runNonce,
      fromE164,
      toE164,
      expectedPayload: body,
      idempotencyKey,
      confirmationIngressUrl:
        "https://agent.example.test/provider-canary/twilio/confirmation",
      statusCallbackUrl:
        "https://agent.example.test/provider-canary/twilio/status",
      exactConfirmationBody: `Confirm Twilio sms canary ${runNonce}: from ${fromE164} to ${toE164}; payload-sha256 ${digest(body)}; idempotency-key ${idempotencyKey}`,
      consent: {
        sourceNumberOperatorOwned: true,
        targetOwnerConsented: true,
        consentEvidenceRefSha256: consentSha256,
        voiceRecordingEnabled: false,
      },
      deploymentEvidence: {
        ...descriptor,
        providerStatusReadback: "twilio-rest-v2010",
      },
    },
  };
}

function sign(url: string, form: string): string {
  const entries = [...new URLSearchParams(form).entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return createHmac("sha1", authToken)
    .update(`${url}${entries.map(([key, value]) => `${key}${value}`).join("")}`)
    .digest("base64");
}

function callback(material: TwilioAuthorizedMaterial, status = "delivered") {
  const requestUrl = material.plan.statusCallbackUrl;
  const rawFormBody = new URLSearchParams({
    AccountSid: accountSid,
    MessageSid: messageSid,
    MessageStatus: status,
    From: fromE164,
    To: toE164,
  }).toString();
  return {
    requestUrl,
    rawFormBody,
    twilioSignature: sign(requestUrl, rawFormBody),
    receivedAtIso: "2026-08-20T18:00:00.000Z",
  };
}

function context(material: TwilioAuthorizedMaterial) {
  return {
    manifestSha256: material.authorization.manifest.manifestSha256,
    repositorySha,
    deploymentSha,
    runId: material.authorization.manifest.run.runId,
    scenarioId: smsScenario.id,
    operationKind: "twilio.sms-send",
    requestNonce: "r".repeat(64),
    requestSha256: digest("request"),
    authorizationGrantSha256: digest("service-grant"),
  } as const;
}

function correlation(material: TwilioAuthorizedMaterial) {
  const manifest = material.authorization.manifest;
  return {
    scenarioId: smsScenario.id,
    operationKind: "twilio.sms-send" as const,
    controllerFamily: "twilio" as const,
    runId: manifest.run.runId,
    runNonce,
    manifestSha256: manifest.manifestSha256,
    repositorySha,
    deploymentSha,
    targetOperationSha256: canonicalSha256(
      manifest.target.operation,
      "providerBridge.targetOperation",
    ),
    failureProbesSha256: canonicalSha256(
      manifest.requiredFailureProbes,
      "providerBridge.failureProbes",
    ),
  };
}

describe("Twilio provider service adapters", () => {
  it("verifies the exact terminal provider callback and rejects tampering", () => {
    const material = fixture();
    const preflight = preflightTwilioOperatorCanary(material);
    expect(
      collectTwilioStatusCallback({
        preflight,
        resourceSid: messageSid,
        authToken,
        callback: callback(material),
      }),
    ).toMatchObject({
      resourceSid: messageSid,
      status: "delivered",
      signatureValidated: true,
      qualificationClaimed: false,
    });
    expect(() =>
      collectTwilioStatusCallback({
        preflight,
        resourceSid: messageSid,
        authToken,
        callback: callback(material, "failed"),
      }),
    ).toThrow(/terminal Twilio effect/);
    expect(() =>
      collectTwilioStatusCallback({
        preflight,
        resourceSid: messageSid,
        authToken,
        callback: { ...callback(material), twilioSignature: "tampered" },
      }),
    ).toThrow(/signature is invalid/);
  });

  it("requires production plugin-phone functions and forwards them unchanged", async () => {
    expect(() =>
      createPluginPhoneTwilioDispatchBoundary({
        sendTwilioSms: undefined as never,
        sendTwilioVoiceCall: vi.fn(),
      }),
    ).toThrow(/production plugin-phone/);
    const sendTwilioSms = vi.fn(async () => ({
      ok: true,
      status: 201,
      sid: messageSid,
    }));
    const boundary = createPluginPhoneTwilioDispatchBoundary({
      sendTwilioSms,
      sendTwilioVoiceCall: vi.fn(),
    });
    await boundary.sendSms({
      credentials: { accountSid, authToken, fromPhoneNumber: fromE164 },
      to: toE164,
      body,
      statusCallbackUrl:
        "https://agent.example.test/provider-canary/twilio/status",
      idempotencyKey,
    });
    expect(sendTwilioSms).toHaveBeenCalledWith({
      credentials: { accountSid, authToken, fromPhoneNumber: fromE164 },
      to: toE164,
      body,
      statusCallbackUrl:
        "https://agent.example.test/provider-canary/twilio/status",
      idempotencyKey,
    });
  });

  it("refuses request drift before dispatching a provider effect", async () => {
    const material = fixture();
    const service = {
      sendSms: vi.fn(),
      sendVoiceCall: vi.fn(),
    };
    const adapter = createTwilioControllerServiceAdapter({
      materials: { resolve: async () => material },
      credential: { resolve: vi.fn() },
      service,
      deployed: {} as never,
      cleanupRegistry: {} as never,
    });
    await expect(
      adapter.execute(context(material), {
        correlation: correlation(material),
        providerTarget: { fromE164, toE164: "+15551239999" },
        operationInput: material.operationInput,
        failureProbes: material.failureProbes,
      }),
    ).rejects.toThrow(/provider target differs/);
    expect(service.sendSms).not.toHaveBeenCalled();
  });

  it("does not register cleanup authority before authenticated ingress", async () => {
    const material = fixture();
    const cleanupRegistry = {
      prepare: vi.fn(),
      recordDispatched: vi.fn(),
      recordObserved: vi.fn(),
      recordReconciliationRequired: vi.fn(),
      resolve: vi.fn(),
    };
    const service = {
      sendSms: vi.fn(),
      sendVoiceCall: vi.fn(),
    };
    const adapter = createTwilioControllerServiceAdapter({
      materials: { resolve: async () => material },
      credential: {
        resolve: async () => ({
          accountSid,
          authToken,
          fromE164,
          role: "controller" as const,
        }),
      },
      service,
      deployed: {
        acceptAuthenticatedIngress: vi.fn(async () => {
          throw new Error("authenticated ingress rejected");
        }),
      } as unknown as TwilioDeployedRuntimeBoundary,
      cleanupRegistry,
    });
    await expect(
      adapter.execute(context(material), {
        correlation: correlation(material),
        providerTarget: material.providerTarget,
        operationInput: material.operationInput,
        failureProbes: material.failureProbes,
      }),
    ).rejects.toThrow(/deployed provider-canary contract/);
    expect(cleanupRegistry.prepare).not.toHaveBeenCalled();
    expect(cleanupRegistry.recordReconciliationRequired).not.toHaveBeenCalled();
    expect(service.sendSms).not.toHaveBeenCalled();
  });

  it("registers cleanup after authenticated ingress and records ambiguous dispatch for reconciliation", async () => {
    const material = fixture();
    const cleanupScopeSha256 = digest("prepared-cleanup-scope");
    const cleanupRegistry = {
      prepare: vi.fn(async () => ({ cleanupScopeSha256 })),
      recordDispatched: vi.fn(),
      recordObserved: vi.fn(),
      recordReconciliationRequired: vi.fn(async () => undefined),
      resolve: vi.fn(),
    };
    const adapter = createTwilioControllerServiceAdapter({
      materials: { resolve: async () => material },
      credential: {
        resolve: async () => ({
          accountSid,
          authToken,
          fromE164,
          role: "controller" as const,
        }),
      },
      service: {
        sendSms: vi.fn(async () => ({
          ok: false,
          status: 503,
          error: "ambiguous transport failure",
        })),
        sendVoiceCall: vi.fn(),
      },
      deployed: {
        acceptAuthenticatedIngress: async ({
          binding,
        }: Parameters<
          TwilioDeployedRuntimeBoundary["acceptAuthenticatedIngress"]
        >[0]) => ({
          sessionId: "twilio-session-001",
          receipt: {
            ...binding,
            ingressEndpointOriginSha256:
              material.plan.deploymentEvidence.ingressEndpointOriginSha256,
            authenticationProofSha256: digest("authentication-proof"),
            correlationId: "twilio-correlation-001",
            acceptedAtIso: new Date().toISOString(),
            authenticated: true as const,
          },
        }),
        cleanupOrReconcile: async ({
          binding,
          correlationId,
        }: Parameters<
          TwilioDeployedRuntimeBoundary["cleanupOrReconcile"]
        >[0]) => ({
          descriptorSha256: binding.descriptorSha256,
          scenarioId: binding.scenarioId,
          runId: binding.runId,
          correlationId,
          reconciliationOwnerRefSha256:
            material.plan.deploymentEvidence.reconciliationOwnerRefSha256,
          status: "cleaned" as const,
          completedAtIso: new Date().toISOString(),
        }),
      } as unknown as TwilioDeployedRuntimeBoundary,
      cleanupRegistry,
    });
    await expect(
      adapter.execute(context(material), {
        correlation: correlation(material),
        providerTarget: material.providerTarget,
        operationInput: material.operationInput,
        failureProbes: material.failureProbes,
      }),
    ).rejects.toThrow(/requires reconciliation/);
    expect(cleanupRegistry.prepare).toHaveBeenCalledOnce();
    expect(cleanupRegistry.recordDispatched).not.toHaveBeenCalled();
    expect(cleanupRegistry.recordReconciliationRequired).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupScopeSha256 }),
    );
  });

  it("uses cleanup-only credentials and refuses unresolved provider cleanup", async () => {
    const material = fixture();
    const ctx = context(material);
    const cleanupScopeSha256 = digest("cleanup-scope");
    const resource: TwilioProviderResource = {
      schema: "eliza.twilio-provider-canary-cleanup-registration.v1",
      scenarioId: smsScenario.id,
      operationKind: "twilio.sms-send",
      channel: "sms",
      accountSid,
      fromE164,
      toE164,
      idempotencyKeySha256: digest(idempotencyKey),
      resourceSid: messageSid,
      callbackReceiptSha256: digest("callback"),
      providerReadbackSha256: digest("readback"),
    };
    const credential: TwilioCredentialGrant = {
      accountSid,
      authToken,
      fromE164,
      role: "cleanup",
    };
    const request = {
      correlation: correlation(material),
      cleanupScopeSha256,
      rawControllerMaterialSha256: digest("raw"),
      completedStages: ["controller"],
      failed: false,
    };
    const provider = {
      cleanupResource: vi.fn(async () => ({
        disposition: "deleted" as const,
        resourceKind: "message" as const,
        resourceSid: messageSid,
      })),
    };
    const adapter = createTwilioCleanupServiceAdapter({
      registry: {
        prepare: vi.fn(),
        recordDispatched: vi.fn(),
        recordObserved: vi.fn(),
        recordReconciliationRequired: vi.fn(),
        resolve: async () => resource,
      },
      credential: { resolve: async () => credential },
      service: provider,
      now: () => new Date("2026-08-20T18:05:00.000Z"),
    });
    await expect(adapter.executeCleanup(ctx, request)).resolves.toMatchObject({
      disposition: "cleaned",
      cleanupScopeSha256,
    });
    expect(provider.cleanupResource).toHaveBeenCalledWith({
      credentials: {
        accountSid,
        authToken,
        fromPhoneNumber: fromE164,
      },
      resourceKind: "message",
      resourceSid: messageSid,
    });
    const refusing = createTwilioCleanupServiceAdapter({
      registry: {
        prepare: vi.fn(),
        recordDispatched: vi.fn(),
        recordObserved: vi.fn(),
        recordReconciliationRequired: vi.fn(),
        resolve: async () => resource,
      },
      credential: { resolve: async () => credential },
      service: {
        cleanupResource: async () => ({
          disposition: "reconciliation-required" as const,
          resourceKind: "message" as const,
          resourceSid: messageSid,
          reason: "deletion-unverified",
        }),
      },
    });
    await expect(refusing.executeCleanup(ctx, request)).rejects.toThrow(
      /requires reconciliation/,
    );
  });

  it("requires and preserves the production plugin-phone cleanup helper", async () => {
    expect(() =>
      createPluginPhoneTwilioCleanupBoundary({
        cleanupTwilioProviderResource: undefined as never,
      }),
    ).toThrow(/production plugin-phone Twilio cleanup/);
    const cleanupTwilioProviderResource = vi.fn(async () => ({
      disposition: "already-absent" as const,
      resourceKind: "message" as const,
      resourceSid: messageSid,
    }));
    const boundary = createPluginPhoneTwilioCleanupBoundary({
      cleanupTwilioProviderResource,
    });
    const request = {
      credentials: { accountSid, authToken, fromPhoneNumber: fromE164 },
      resourceKind: "message" as const,
      resourceSid: messageSid,
    };
    await expect(boundary.cleanupResource(request)).resolves.toMatchObject({
      disposition: "already-absent",
      resourceSid: messageSid,
    });
    expect(cleanupTwilioProviderResource).toHaveBeenCalledWith(request);
  });
});
