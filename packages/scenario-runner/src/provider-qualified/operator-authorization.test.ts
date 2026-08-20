/**
 * Exercises the real Ed25519 operator-authorization boundary with ephemeral
 * keys while keeping provider execution and observation explicitly absent.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
  preflightAuthorizedProviderCanary,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function failureProbeMaterials() {
  return [
    {
      probeId: "calendar-auth-denied",
      requestPayload: { title: "Denied canary event" },
      expectedErrorCode: "insufficient-scope",
      scope: { calendarId: "operator-canary-calendar" },
      authorizationGrant: { grant: "denied-calendar-grant" },
    },
    {
      probeId: "calendar-provider-rejected",
      requestPayload: { title: "Rejected canary event" },
      expectedErrorCode: "invalid-event",
      scope: { calendarId: "operator-canary-calendar" },
      authorizationGrant: { grant: "calendar-write-grant" },
    },
  ] as const;
}

function scenario(): ScenarioDefinition {
  return {
    id: "provider.calendar.operator-authorization",
    title: "Provider-qualified calendar operator authorization",
    domain: "provider-canary",
    lane: "live-only",
    executionProfile: "provider-qualified",
    evidenceScope: "provider-certification",
    isolation: "per-scenario",
    turns: [
      {
        name: "authenticated production ingress",
        kind: "message",
        text: "Create exactly one harmless event on the bound canary calendar.",
        responseJudge: {
          rubric:
            "The response distinguishes an attempt from provider acceptance.",
          minimumScore: 0.9,
        },
      },
    ],
    finalChecks: [
      {
        type: "providerEffectObserved",
        name: "calendar-event-create",
        observerId: "calendar-observer",
        provider: "google-calendar",
        connectorProvider: "google",
        accountId: "operator-calendar-account",
        operation: "event-create",
        minCount: 1,
      },
      {
        type: "judgeRubric",
        name: "truthful-result",
        rubric: "Provider success is claimed only when independently observed.",
        minimumScore: 0.9,
      },
    ],
  };
}

function bindings(
  manifestAuthorityKeyId: string,
  observerKeyId = hash("observer-key"),
  judgeKeyId = hash("judge-key"),
): ProviderRunBindings {
  const accountRefSha256 = hash("operator-calendar-account");
  const connectionRefSha256 = hash("operator-calendar-connection");
  const principalRefSha256 = hash("operator-principal");
  const roomRefSha256 = hash("operator-room");
  const [authDeniedProbe, rejectedProbe] = failureProbeMaterials().map(
    (material) => createProviderFailureProbeHashBinding(material),
  );
  return {
    runId: "operator-run-001",
    runNonce: "n".repeat(64),
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId,
      observerSigners: [
        { observerId: "calendar-observer", keyId: observerKeyId },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: "google-calendar.event-create",
        providerTarget: { calendarId: "operator-canary-calendar" },
        operationInput: {
          title: "Harmless canary event",
          start: "2026-08-20T17:00:00.000Z",
          end: "2026-08-20T17:15:00.000Z",
          timeZone: "UTC",
          attendees: [],
          location: null,
          description: null,
          createMeetLink: false,
          sendUpdates: "none",
          recurrence: [],
          idempotencyKey: "calendar-canary-001",
        },
      }),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "acting-provider",
      actingModel: "acting-model",
      judgeProvider: "independent-judge-provider",
      judgeModel: "independent-judge-model",
      judgeKeyId,
    },
    connectors: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-api",
      provider: "google",
      channel: "operator-canary",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://canary.example.test"),
    },
    capabilities: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        capability: "event-create",
        authorizationGrantSha256: hash("calendar-write-grant"),
      },
    ],
    observationContracts: [
      {
        contractId: "calendar-event-create",
        kind: "provider-effect",
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "operator-canary",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "google-calendar",
        operation: "event-create",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authDeniedProbe.probeId,
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "operator-canary",
        provider: "google-calendar",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: "event-create",
        failureClass: "authorization-denied",
        requestPayloadSha256: authDeniedProbe.requestPayloadSha256,
        expectedStatusCode: 403,
        expectedErrorCodeSha256: authDeniedProbe.expectedErrorCodeSha256,
        scopeSha256: authDeniedProbe.scopeSha256,
        authorizationGrantSha256: authDeniedProbe.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
      {
        probeId: rejectedProbe.probeId,
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "operator-canary",
        provider: "google-calendar",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: "event-create",
        failureClass: "provider-rejected",
        requestPayloadSha256: rejectedProbe.requestPayloadSha256,
        expectedStatusCode: 400,
        expectedErrorCodeSha256: rejectedProbe.expectedErrorCodeSha256,
        scopeSha256: rejectedProbe.scopeSha256,
        authorizationGrantSha256: rejectedProbe.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
    ],
  };
}

function authority() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  return {
    ...keyPair,
    publicKeyPem,
    keyId: providerObserverKeyId(publicKeyPem),
  };
}

describe("provider canary operator authorization", () => {
  it("binds provider-native target and operation input before execution", () => {
    const signer = authority();
    const definition = scenario();
    const providerTarget = { calendarId: "operator-canary-calendar" };
    const operationInput = {
      title: "Harmless canary event",
      start: "2026-08-20T17:00:00.000Z",
      end: "2026-08-20T17:15:00.000Z",
      timeZone: "UTC",
      attendees: [],
      location: null,
      description: null,
      createMeetLink: false,
      sendUpdates: "none",
      recurrence: [],
      idempotencyKey: "calendar-canary-001",
    };
    const targetBinding = createProviderCanaryTargetBinding({
      kind: "google-calendar.event-create",
      providerTarget,
      operationInput,
    });
    const bound = bindings(signer.keyId);
    bound.target = {
      ...bound.target,
      operation: targetBinding,
    };
    const authorization = authorizeProviderCanary({
      scenario: definition,
      bindings: bound,
      manifestAuthorityPrivateKey: signer.privateKey,
    });
    const executionPreflight = preflightAuthorizedProviderCanaryExecution({
      scenario: definition,
      authorization,
      pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
      operationKind: "google-calendar.event-create",
      providerTarget,
      operationInput,
      failureProbes: failureProbeMaterials(),
    });
    expect(executionPreflight.targetBinding).toEqual(targetBinding);
    expect(executionPreflight.failureProbeBindings).toEqual(
      failureProbeMaterials().map((material) =>
        createProviderFailureProbeHashBinding(material),
      ),
    );
    const reversedPreflight = preflightAuthorizedProviderCanaryExecution({
      scenario: definition,
      authorization,
      pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
      operationKind: "google-calendar.event-create",
      providerTarget,
      operationInput,
      failureProbes: [failureProbeMaterials()[1], failureProbeMaterials()[0]],
    });
    expect(reversedPreflight.failureProbeBindings).toEqual(
      executionPreflight.failureProbeBindings,
    );
    expect(() =>
      preflightAuthorizedProviderCanaryExecution({
        scenario: definition,
        authorization,
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
        operationKind: "google-calendar.event-create",
        providerTarget: { calendarId: "wrong-calendar" },
        operationInput,
        failureProbes: failureProbeMaterials(),
      }),
    ).toThrow(/does not match the signed manifest/);
    expect(() =>
      preflightAuthorizedProviderCanaryExecution({
        scenario: definition,
        authorization,
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
        operationKind: "google-calendar.event-create",
        providerTarget,
        operationInput,
        failureProbes: [
          {
            ...failureProbeMaterials()[0],
            expectedErrorCode: "substituted-error",
          },
          failureProbeMaterials()[1],
        ],
      }),
    ).toThrow(/failure probe material does not match the signed manifest/);
    expect(() =>
      preflightAuthorizedProviderCanaryExecution({
        scenario: definition,
        authorization,
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
        operationKind: "google-calendar.event-create",
        providerTarget,
        operationInput,
        failureProbes: [failureProbeMaterials()[0], failureProbeMaterials()[0]],
      }),
    ).toThrow(/duplicates probeId/);
    expect(() =>
      createProviderFailureProbeHashBinding({
        ...failureProbeMaterials()[0],
        bearerToken: "must-not-be-accepted",
      } as never),
    ).toThrow(/closed shape/);
  });

  it("authorizes and preflights one exact manifest without serializing the private key", () => {
    const signer = authority();
    const definition = scenario();
    const authorization = authorizeProviderCanary({
      scenario: definition,
      bindings: bindings(signer.keyId),
      manifestAuthorityPrivateKey: signer.privateKey,
    });

    expect(JSON.stringify(authorization)).not.toContain("PRIVATE KEY");
    expect(authorization.manifestSignature.keyId).toBe(signer.keyId);
    expect(authorization.manifestSignature.signature).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(
      preflightAuthorizedProviderCanary({
        scenario: definition,
        authorization: JSON.parse(JSON.stringify(authorization)),
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
      }),
    ).toEqual({
      status: "operator-authorization-validated",
      scenarioId: definition.id,
      authorization,
    });
  });

  it("refuses a private key that is not the authority declared by the bindings", () => {
    const declared = authority();
    const attacker = authority();
    expect(() =>
      authorizeProviderCanary({
        scenario: scenario(),
        bindings: bindings(declared.keyId),
        manifestAuthorityPrivateKey: attacker.privateKey,
      }),
    ).toThrow(/does not match bindings\.trust\.manifestAuthorityKeyId/);
  });

  it("accepts only Ed25519 private KeyObjects", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      authorizeProviderCanary({
        scenario: scenario(),
        bindings: bindings(hash("unused-authority")),
        manifestAuthorityPrivateKey: rsa.privateKey,
      }),
    ).toThrow(/must be an Ed25519 private KeyObject/);
  });

  it("rejects an unpinned signer, a forged signature, and a changed scenario", () => {
    const signer = authority();
    const other = authority();
    const definition = scenario();
    const authorization = authorizeProviderCanary({
      scenario: definition,
      bindings: bindings(signer.keyId),
      manifestAuthorityPrivateKey: signer.privateKey,
    });

    expect(() =>
      preflightAuthorizedProviderCanary({
        scenario: definition,
        authorization,
        pinnedManifestAuthorityPublicKeysPem: [other.publicKeyPem],
      }),
    ).toThrow(/invalid or not signed by a pinned authority/);

    const forged = structuredClone(authorization);
    forged.manifestSignature.signature = "A".repeat(86);
    expect(() =>
      preflightAuthorizedProviderCanary({
        scenario: definition,
        authorization: forged,
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
      }),
    ).toThrow(/invalid or not signed by a pinned authority/);

    const changed = scenario();
    const changedTurn = changed.turns[0];
    if (!changedTurn) throw new Error("test scenario is missing its turn");
    changedTurn.text = "Delete every event.";
    expect(() =>
      preflightAuthorizedProviderCanary({
        scenario: changed,
        authorization,
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
      }),
    ).toThrow(/does not exactly match/);
  });

  it("rejects non-canonical signatures, duplicate pins, and unknown bundle fields", () => {
    const signer = authority();
    const definition = scenario();
    const authorization = authorizeProviderCanary({
      scenario: definition,
      bindings: bindings(signer.keyId),
      manifestAuthorityPrivateKey: signer.privateKey,
    });

    const padded = structuredClone(authorization);
    padded.manifestSignature.signature += "=";
    expect(() =>
      preflightAuthorizedProviderCanary({
        scenario: definition,
        authorization: padded,
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
      }),
    ).toThrow(/must be unpadded base64url/);

    expect(() =>
      preflightAuthorizedProviderCanary({
        scenario: definition,
        authorization,
        pinnedManifestAuthorityPublicKeysPem: [
          signer.publicKeyPem,
          signer.publicKeyPem,
        ],
      }),
    ).toThrow(/duplicates an earlier key/);

    expect(() =>
      preflightAuthorizedProviderCanary({
        scenario: definition,
        authorization: { ...authorization, privateKeyPem: "forbidden" },
        pinnedManifestAuthorityPublicKeysPem: [signer.publicKeyPem],
      }),
    ).toThrow(/closed shape/);
  });

  it("rejects accessor-backed bindings and pins without invoking them", () => {
    const signer = authority();
    const hostileBindings = bindings(signer.keyId);
    let bindingGetterCalls = 0;
    Object.defineProperty(hostileBindings.trust, "manifestAuthorityKeyId", {
      enumerable: true,
      get() {
        bindingGetterCalls += 1;
        return signer.keyId;
      },
    });
    expect(() =>
      authorizeProviderCanary({
        scenario: scenario(),
        bindings: hostileBindings,
        manifestAuthorityPrivateKey: signer.privateKey,
      }),
    ).toThrow(/accessor/);
    expect(bindingGetterCalls).toBe(0);

    const definition = scenario();
    const authorization = authorizeProviderCanary({
      scenario: definition,
      bindings: bindings(signer.keyId),
      manifestAuthorityPrivateKey: signer.privateKey,
    });
    let pinGetterCalls = 0;
    const hostilePins: [string] = [signer.publicKeyPem];
    Object.defineProperty(hostilePins, "0", {
      enumerable: true,
      get() {
        pinGetterCalls += 1;
        return signer.publicKeyPem;
      },
    });
    expect(() =>
      preflightAuthorizedProviderCanary({
        scenario: definition,
        authorization,
        pinnedManifestAuthorityPublicKeysPem: hostilePins,
      }),
    ).toThrow(/data property/);
    expect(pinGetterCalls).toBe(0);
  });
});
