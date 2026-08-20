/**
 * Exercises Twilio operator preflight, signed ingress, and provider readback
 * with real Ed25519/HMAC verification and deterministic HTTP responses. No
 * provider effect is created or represented as qualification evidence.
 */

import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import smsScenario from "../../../test/scenarios/provider-qualified/provider.twilio-sms.confirmed-send.scenario.ts";
import voiceScenario from "../../../test/scenarios/provider-qualified/provider.twilio-voice.confirmed-call.scenario.ts";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";
import {
  assertTwilioOperatorCanaryExecutable,
  collectTwilioAuthenticatedIngress,
  collectTwilioRawStatusReadback,
  preflightTwilioOperatorCanary,
  type TwilioCanaryChannel,
  type TwilioOperatorPlan,
} from "./twilio-operator-controller.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const accountSid = `AC${"1".repeat(32)}`;
const messageSid = `SM${"2".repeat(32)}`;
const callSid = `CA${"3".repeat(32)}`;
const fromE164 = "+15551230001";
const toE164 = "+15551230002";
const runNonce = "n".repeat(64);
const authToken = "a".repeat(32);
const consentGrant = { grant: "twilio-target-owner-consent", version: 1 };
const consentEvidenceRefSha256 = hash(
  JSON.stringify(consentGrant, Object.keys(consentGrant).sort()),
);

type FixtureChannel = "sms" | "voice";

function channelContract(channel: FixtureChannel) {
  return channel === "sms"
    ? {
        scenario: smsScenario,
        scenarioId: "provider.twilio-sms.confirmed-send" as const,
        operationKind: "twilio.sms-send" as const,
        operation: "sms-send",
        capability: "sms-send",
        payload: "Twilio SMS provider canary delivery",
        operationInput: {
          body: "Twilio SMS provider canary delivery",
          idempotencyKey: "twilio-sms-canary-confirmation-001",
        },
      }
    : {
        scenario: voiceScenario,
        scenarioId: "provider.twilio-voice.confirmed-call" as const,
        operationKind: "twilio.call-create" as const,
        operation: "call-create",
        capability: "call-create",
        payload: "Twilio voice provider canary call",
        operationInput: {
          message: "Twilio voice provider canary call",
          idempotencyKey: "twilio-voice-canary-confirmation-001",
        },
      };
}

function failureProbeMaterials(channel: FixtureChannel) {
  return [
    {
      probeId: `twilio-${channel}-authorization-denied`,
      requestPayload: { fromE164, toE164, denied: true },
      expectedErrorCode: "authentication-failed",
      scope: { accountSid, fromE164, toE164 },
      authorizationGrant: { grant: "denied-twilio-grant" },
    },
    {
      probeId: `twilio-${channel}-provider-rejected`,
      requestPayload: { fromE164, toE164: "+15550000000", rejected: true },
      expectedErrorCode: "invalid-destination",
      scope: { accountSid, fromE164, toE164 },
      authorizationGrant: consentGrant,
    },
  ] as const;
}

function canonicalConfirmation(input: {
  channel: TwilioCanaryChannel;
  payload: string;
  idempotencyKey: string;
}): string {
  return `Confirm Twilio ${input.channel} canary ${runNonce}: from ${fromE164} to ${toE164}; payload-sha256 ${hash(input.payload)}; idempotency-key ${input.idempotencyKey}`;
}

function plan(channel: FixtureChannel): TwilioOperatorPlan {
  const contract = channelContract(channel);
  const idempotencyKey = contract.operationInput.idempotencyKey;
  return {
    schema: "eliza.twilio-provider-canary-operator-plan.v1",
    twilioApiOrigin: "https://api.twilio.com",
    channel,
    accountSid,
    runNonce,
    fromE164,
    toE164,
    expectedPayload: contract.payload,
    idempotencyKey,
    confirmationIngressUrl:
      "https://agent.example.test/provider-canary/twilio/confirmation",
    exactConfirmationBody: canonicalConfirmation({
      channel,
      payload: contract.payload,
      idempotencyKey,
    }),
    consent: {
      sourceNumberOperatorOwned: true,
      targetOwnerConsented: true,
      consentEvidenceRefSha256,
      voiceRecordingEnabled: false,
    },
    deploymentEvidence: {
      authenticatedIngressEndpoint: null,
      trajectoryExportEndpoint: null,
      authenticatedReplayExecutor: null,
      independentFailureProbeExecutor: null,
      providerStatusReadback: "twilio-rest-v2010",
    },
  };
}

function fixture(channel: FixtureChannel) {
  const contract = channelContract(channel);
  const authority = generateKeyPairSync("ed25519");
  const publicKeyPem = authority.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const accountRefSha256 = hash("operator-twilio-canary-account");
  const connectionRefSha256 = hash(`operator-twilio-${channel}-connection`);
  const principalRefSha256 = hash(toE164);
  const roomRefSha256 = hash(fromE164);
  const [authorizationDenied, providerRejected] = failureProbeMaterials(
    channel,
  ).map(createProviderFailureProbeHashBinding);
  const bindings: ProviderRunBindings = {
    runId: `twilio-${channel}-operator-run-001`,
    runNonce,
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: providerObserverKeyId(publicKeyPem),
      observerSigners: [
        {
          observerId: "twilio-provider-observer",
          keyId: hash("independent-twilio-provider-observer"),
        },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: contract.operationKind,
        providerTarget: { fromE164, toE164 },
        operationInput: contract.operationInput,
      }),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "live-acting-provider",
      actingModel: "live-acting-model",
      judgeProvider: "independent-judge-provider",
      judgeModel: "independent-judge-model",
      judgeKeyId: hash("independent-judge-key"),
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
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://agent.example.test"),
    },
    capabilities: [
      {
        provider: "twilio",
        accountRefSha256,
        connectionRefSha256,
        capability: contract.capability,
        authorizationGrantSha256: consentEvidenceRefSha256,
      },
    ],
    observationContracts: [
      {
        contractId: `twilio-canary-${contract.operation}`,
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
        operation: contract.operation,
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authorizationDenied.probeId,
        observerId: "twilio-provider-observer",
        sourceKind: "provider-api",
        system: "twilio",
        environment: "operator-canary",
        provider: "twilio",
        connectorProvider: "twilio",
        accountRefSha256,
        connectionRefSha256,
        operation: contract.operation,
        failureClass: "authorization-denied",
        requestPayloadSha256: authorizationDenied.requestPayloadSha256,
        expectedStatusCode: 401,
        expectedErrorCodeSha256: authorizationDenied.expectedErrorCodeSha256,
        scopeSha256: authorizationDenied.scopeSha256,
        authorizationGrantSha256: authorizationDenied.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
      {
        probeId: providerRejected.probeId,
        observerId: "twilio-provider-observer",
        sourceKind: "provider-api",
        system: "twilio",
        environment: "operator-canary",
        provider: "twilio",
        connectorProvider: "twilio",
        accountRefSha256,
        connectionRefSha256,
        operation: contract.operation,
        failureClass: "provider-rejected",
        requestPayloadSha256: providerRejected.requestPayloadSha256,
        expectedStatusCode: 400,
        expectedErrorCodeSha256: providerRejected.expectedErrorCodeSha256,
        scopeSha256: providerRejected.scopeSha256,
        authorizationGrantSha256: providerRejected.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
    ],
  };
  return {
    scenario: contract.scenario as ScenarioDefinition,
    authorization: authorizeProviderCanary({
      scenario: contract.scenario,
      bindings,
      manifestAuthorityPrivateKey: authority.privateKey,
    }),
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
    providerTarget: { fromE164, toE164 },
    operationInput: contract.operationInput,
    failureProbes: failureProbeMaterials(channel),
    plan: plan(channel),
  };
}

function signForm(requestUrl: string, rawFormBody: string): string {
  const entries = [...new URLSearchParams(rawFormBody).entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const payload = `${requestUrl}${entries.map(([key, value]) => `${key}${value}`).join("")}`;
  return createHmac("sha1", authToken).update(payload).digest("base64");
}

describe("Twilio provider-canary operator", () => {
  it.each(["sms", "voice"] as const)(
    "binds the %s plan to signed inputs and reports every execution blocker",
    (channel) => {
      const preflight = preflightTwilioOperatorCanary(fixture(channel));
      expect(preflight.status).toBe("twilio-operator-inputs-validated");
      expect(preflight.blockers.map(({ code }) => code)).toEqual([
        "authenticated-deployed-ingress-unavailable",
        "deployed-trajectory-export-unavailable",
        "authenticated-event-replay-unavailable",
        "independent-failure-probe-executor-unavailable",
      ]);
      expect(() => assertTwilioOperatorCanaryExecutable(preflight)).toThrow(
        /execution refused.*authenticated-deployed-ingress-unavailable/,
      );
    },
  );

  it("rejects E.164, payload, consent, and unknown-field drift offline", () => {
    const input = fixture("sms");
    expect(() =>
      preflightTwilioOperatorCanary({
        ...input,
        plan: { ...input.plan, toE164: "+15551239999" },
      }),
    ).toThrow(/canonical confirmation|E\.164 routing/);
    expect(() =>
      preflightTwilioOperatorCanary({
        ...input,
        plan: {
          ...input.plan,
          expectedPayload: "tampered",
          exactConfirmationBody: canonicalConfirmation({
            channel: "sms",
            payload: "tampered",
            idempotencyKey: input.plan.idempotencyKey,
          }),
        },
      }),
    ).toThrow(/payload or idempotency key/);
    expect(() =>
      preflightTwilioOperatorCanary({
        ...input,
        plan: {
          ...input.plan,
          consent: {
            ...input.plan.consent,
            consentEvidenceRefSha256: hash("different-consent"),
          },
        },
      }),
    ).toThrow(/consent evidence/);
    expect(() =>
      preflightTwilioOperatorCanary({
        ...input,
        plan: { ...input.plan, pretendQualified: true },
      }),
    ).toThrow(/closed shape/);
  });

  it("accepts only the exact Twilio-signed reverse-route confirmation", () => {
    const preflight = preflightTwilioOperatorCanary(fixture("voice"));
    const rawFormBody = new URLSearchParams({
      AccountSid: accountSid,
      MessageSid: messageSid,
      From: toE164,
      To: fromE164,
      Body: preflight.plan.exactConfirmationBody,
      NumMedia: "0",
    }).toString();
    const receipt = collectTwilioAuthenticatedIngress({
      preflight,
      accountSid,
      authToken,
      requestUrl: preflight.plan.confirmationIngressUrl,
      rawFormBody,
      twilioSignature: signForm(
        preflight.plan.confirmationIngressUrl,
        rawFormBody,
      ),
      receivedAt: new Date("2026-08-20T18:00:00.000Z"),
    });
    expect(receipt).toMatchObject({
      signatureValidated: true,
      qualificationClaimed: false,
      accountSid,
      messageSid,
      fromE164: toE164,
      toE164: fromE164,
    });
    expect(JSON.stringify(receipt)).not.toContain(authToken);

    expect(() =>
      collectTwilioAuthenticatedIngress({
        preflight,
        accountSid,
        authToken,
        requestUrl: preflight.plan.confirmationIngressUrl,
        rawFormBody: rawFormBody.replace("NumMedia=0", "NumMedia=1"),
        twilioSignature: signForm(
          preflight.plan.confirmationIngressUrl,
          rawFormBody,
        ),
      }),
    ).toThrow(/signature is invalid/);
  });

  it("rejects signed confirmation-body drift after authenticating Twilio", () => {
    const preflight = preflightTwilioOperatorCanary(fixture("sms"));
    const rawFormBody = new URLSearchParams({
      AccountSid: accountSid,
      MessageSid: messageSid,
      From: toE164,
      To: fromE164,
      Body: `${preflight.plan.exactConfirmationBody} changed`,
    }).toString();
    expect(() =>
      collectTwilioAuthenticatedIngress({
        preflight,
        accountSid,
        authToken,
        requestUrl: preflight.plan.confirmationIngressUrl,
        rawFormBody,
        twilioSignature: signForm(
          preflight.plan.confirmationIngressUrl,
          rawFormBody,
        ),
      }),
    ).toThrow(
      /does not match the exact account, reverse route, and confirmation/,
    );
  });

  it("collects an exact unsigned Message status receipt from production REST", async () => {
    const preflight = preflightTwilioOperatorCanary(fixture("sms"));
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          sid: messageSid,
          account_sid: accountSid,
          from: fromE164,
          to: toE164,
          direction: "outbound-api",
          status: "delivered",
          body: preflight.plan.expectedPayload,
        }),
    );
    const receipt = await collectTwilioRawStatusReadback({
      preflight,
      resourceSid: messageSid,
      accountSid,
      authToken,
      fetchImpl,
      collectedAt: new Date("2026-08-20T18:01:00.000Z"),
    });
    expect(receipt).toMatchObject({
      channel: "sms",
      resourceSid: messageSid,
      status: "delivered",
      payloadSha256: hash(preflight.plan.expectedPayload),
      qualificationClaimed: false,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`,
    );
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    );
  });

  it("collects a route-bound Call receipt without pretending REST proves TwiML", async () => {
    const preflight = preflightTwilioOperatorCanary(fixture("voice"));
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          sid: callSid,
          account_sid: accountSid,
          from: fromE164,
          to: toE164,
          direction: "outbound-api",
          status: "completed",
        }),
    );
    await expect(
      collectTwilioRawStatusReadback({
        preflight,
        resourceSid: callSid,
        accountSid,
        authToken,
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      channel: "voice",
      resourceSid: callSid,
      status: "completed",
      payloadSha256: null,
      qualificationClaimed: false,
    });
  });

  it("rejects provider route/body drift and forged preflights", async () => {
    const preflight = preflightTwilioOperatorCanary(fixture("sms"));
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          sid: messageSid,
          account_sid: accountSid,
          from: fromE164,
          to: "+15551239999",
          direction: "outbound-api",
          status: "sent",
          body: preflight.plan.expectedPayload,
        }),
    );
    await expect(
      collectTwilioRawStatusReadback({
        preflight,
        resourceSid: messageSid,
        accountSid,
        authToken,
        fetchImpl,
      }),
    ).rejects.toThrow(/does not match the exact resource, account, and route/);

    const forged = { ...preflight };
    const noNetwork = vi.fn();
    await expect(
      collectTwilioRawStatusReadback({
        preflight: forged,
        resourceSid: messageSid,
        accountSid,
        authToken,
        fetchImpl: noNetwork,
      }),
    ).rejects.toThrow(/exact validated Twilio preflight result/);
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
