/**
 * Exercises the Duffel operator boundary with real Ed25519 authorization and
 * deterministic sandbox capability doubles. The doubles produce raw receipts,
 * never provider qualification or live-booking evidence.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import scenario from "../../../test/scenarios/provider-qualified/provider.duffel-travel.booking.scenario.ts";
import {
  type DuffelExternalCapabilities,
  type DuffelOperatorPlan,
  executeDuffelOperatorCanary,
  preflightDuffelOperatorCanary,
} from "./duffel-operator-controller.ts";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const accountId = "operator-duffel-canary-account";
const accountRefSha256 = hash(accountId);
const connectionRefSha256 = hash("duffel-sandbox-connection");
const approvalConnectionRefSha256 = hash("duffel-approval-ledger-connection");
const ownerPrincipalRefSha256 = hash("duffel-owner-principal");
const roomRefSha256 = hash("duffel-owner-room");
const runNonce = "d".repeat(64);
const scopeSha256 = hash("duffel-preapproval-effects");
const stateSha256 = hash("duffel-sandbox-state");
const approvalIdSha256 = hash("duffel-approval-id");
const timestamp = {
  observerStart: "2026-08-20T18:00:00.000Z",
  proposal: "2026-08-20T18:00:01.000Z",
  observerEnd: "2026-08-20T18:00:02.000Z",
  approvalIngress: "2026-08-20T18:00:03.000Z",
  approved: "2026-08-20T18:00:04.000Z",
  done: "2026-08-20T18:00:05.000Z",
};

const providerTarget = {
  offerId: "off_duffel_sandbox_canary",
  itinerary: {
    origin: "JFK",
    destination: "EWR",
    departureDate: "2027-01-10",
    returnDate: null,
    passengerCount: 1,
  },
};

const operationInput = {
  orderType: "hold",
  totalCents: 29950,
  currency: "USD",
  passengers: [
    {
      offerPassengerId: "pas_duffel_sandbox_canary",
      givenName: "Canary",
      familyName: "Operator",
      bornOn: "1990-05-20",
      email: "canary@example.com",
      phoneNumber: "+14155552671",
      title: "mr",
      gender: "m",
    },
  ],
  calendarSync: {
    enabled: false,
    calendarId: null,
    title: null,
    description: null,
    location: null,
    timeZone: null,
  },
} as const;

const probes = [
  {
    probeId: "duffel-authorization-denied",
    requestPayload: { offerId: providerTarget.offerId, effect: "must-not-run" },
    expectedErrorCode: "duffel-authentication-failed",
    scope: { accountId },
    authorizationGrant: { grant: "denied" },
  },
  {
    probeId: "duffel-provider-rejected",
    requestPayload: { orderType: "hold", offerId: "off_invalid" },
    expectedErrorCode: "not-valid-with-selected-offer",
    scope: { accountId },
    authorizationGrant: { grant: "air.orders.create" },
  },
] as const;

function fixture() {
  const authority = generateKeyPairSync("ed25519");
  const publicKeyPem = authority.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const keyId = providerObserverKeyId(publicKeyPem);
  const [denied, rejected] = probes.map(createProviderFailureProbeHashBinding);
  const bindings: ProviderRunBindings = {
    runId: "duffel-sandbox-operator-run",
    runNonce,
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: keyId,
      observerSigners: [
        {
          observerId: "duffel-provider-observer",
          keyId: hash("duffel-independent-observer"),
        },
      ],
    },
    target: {
      principalRefSha256: ownerPrincipalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: "duffel.booking-hold-create",
        providerTarget,
        operationInput,
      }),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "live-acting-provider",
      actingModel: "live-acting-model",
      judgeProvider: "independent-judge-provider",
      judgeModel: "independent-judge-model",
      judgeKeyId: hash("duffel-independent-judge"),
    },
    connectors: [
      {
        provider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        environment: "sandbox",
      },
      {
        provider: "approval-ledger",
        accountRefSha256,
        connectionRefSha256: approvalConnectionRefSha256,
        environment: "sandbox",
      },
    ],
    ingress: {
      kind: "provider-api",
      provider: "duffel",
      channel: "duffel-sandbox-owner-ingress",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: ownerPrincipalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://deployed-agent.example.test"),
    },
    capabilities: [
      {
        provider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        capability: "booking-hold-create",
        authorizationGrantSha256: hash("duffel-booking-grant"),
      },
      {
        provider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        capability: "booking-order-create",
        authorizationGrantSha256: hash("duffel-order-read-grant"),
      },
      {
        provider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        capability: "payment-create",
        authorizationGrantSha256: hash("duffel-payment-read-grant"),
      },
      {
        provider: "approval-ledger",
        accountRefSha256,
        connectionRefSha256: approvalConnectionRefSha256,
        capability: "book_travel",
        authorizationGrantSha256: hash("duffel-approval-read-grant"),
      },
    ],
    observationContracts: [
      {
        contractId: "duffel-canary-booking-hold-create",
        kind: "provider-effect",
        observerId: "duffel-provider-observer",
        sourceKind: "provider-api",
        system: "duffel",
        environment: "sandbox",
        connectorProvider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "duffel",
        operation: "booking-hold-create",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
      ...(["pending", "approved", "done"] as const).map((state, index) => ({
        contractId: `duffel-canary-approval-${state}`,
        kind: "durable-approval" as const,
        observerId: "duffel-provider-observer",
        sourceKind: "durable-database" as const,
        system: "eliza-approval-ledger",
        environment: "sandbox",
        connectorProvider: "approval-ledger",
        accountRefSha256,
        connectionRefSha256: approvalConnectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        operation: "book_travel",
        state,
        transitionGroupId: "duffel-hold-approval",
        transitionIndex: index,
        trajectoryPhase:
          index === 0 ? ("proposal" as const) : ("approval" as const),
      })),
      {
        contractId: "duffel-canary-no-order-or-payment-before-approval",
        kind: "provider-no-effect",
        observerId: "duffel-provider-observer",
        sourceKind: "provider-api",
        system: "duffel",
        environment: "sandbox",
        connectorProvider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "duffel",
        effectKinds: ["booking-order-create", "payment-create"],
        scopeSha256,
        intervalCoverage: "before-referenced-stage",
        trajectoryPhase: "approval",
      },
    ],
    failureProbes: [
      {
        probeId: denied.probeId,
        observerId: "duffel-provider-observer",
        sourceKind: "provider-api",
        system: "duffel",
        environment: "sandbox",
        provider: "duffel",
        connectorProvider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        operation: "booking-hold-create",
        failureClass: "authorization-denied",
        requestPayloadSha256: denied.requestPayloadSha256,
        expectedStatusCode: 401,
        expectedErrorCodeSha256: denied.expectedErrorCodeSha256,
        scopeSha256: denied.scopeSha256,
        authorizationGrantSha256: denied.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
      {
        probeId: rejected.probeId,
        observerId: "duffel-provider-observer",
        sourceKind: "provider-api",
        system: "duffel",
        environment: "sandbox",
        provider: "duffel",
        connectorProvider: "duffel",
        accountRefSha256,
        connectionRefSha256,
        operation: "booking-hold-create",
        failureClass: "provider-rejected",
        requestPayloadSha256: rejected.requestPayloadSha256,
        expectedStatusCode: 422,
        expectedErrorCodeSha256: rejected.expectedErrorCodeSha256,
        scopeSha256: rejected.scopeSha256,
        authorizationGrantSha256: rejected.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
    ],
  };
  const authorization = authorizeProviderCanary({
    scenario,
    bindings,
    manifestAuthorityPrivateKey: authority.privateKey,
  });
  const plan: DuffelOperatorPlan = {
    schema: "eliza.duffel-provider-canary-operator-plan.v1",
    scenarioId: "provider.duffel-travel.booking",
    environment: "sandbox",
    accountId,
    connectionRefSha256,
    ownerPrincipalRefSha256,
    runNonce,
  };
  return {
    scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
    providerTarget,
    operationInput,
    failureProbes: probes,
    plan,
  };
}

function preflight() {
  return preflightDuffelOperatorCanary(fixture());
}

function capabilities(
  approvalPayloadSha256: string,
): DuffelExternalCapabilities & { calls: string[] } {
  const calls: string[] = [];
  const capability = {
    assertSandboxCredentialReady: vi.fn(async () => {
      calls.push("credential");
      return {
        accountId,
        connectionRefSha256,
        environment: "sandbox",
        liveMode: false,
        readWrite: true,
        checkedAtIso: timestamp.observerStart,
      };
    }),
    beginPreapprovalNoEffectObservation: vi.fn(async () => {
      calls.push("observer-begin");
      return {
        complete: vi.fn(async () => {
          calls.push("observer-complete");
          return {
            scopeSha256,
            observationStartedAtIso: timestamp.observerStart,
            observationEndedAtIso: timestamp.observerEnd,
            providerStateBeforeSha256: stateSha256,
            providerStateAfterSha256: stateSha256,
            orderCreateCount: 0,
            paymentCreateCount: 0,
          };
        }),
      };
    }),
    sendAuthenticatedProposalIngress: vi.fn(async () => {
      calls.push("proposal");
      return {
        requestId: "proposal-ingress-request",
        acceptedAtIso: timestamp.proposal,
        authenticatedPrincipalRefSha256: ownerPrincipalRefSha256,
        approvalIdSha256,
        approvalPayloadSha256,
        state: "pending",
        approvedAtIso: null,
        doneAtIso: null,
        providerOrderId: null,
      };
    }),
    sendAuthenticatedApprovalIngress: vi.fn(async () => {
      calls.push("approval");
      return {
        requestId: "approval-ingress-request",
        acceptedAtIso: timestamp.approvalIngress,
        authenticatedPrincipalRefSha256: ownerPrincipalRefSha256,
        approvalIdSha256,
        approvalPayloadSha256,
        state: "done",
        approvedAtIso: timestamp.approved,
        doneAtIso: timestamp.done,
        providerOrderId: "ord_duffel_sandbox_canary",
      };
    }),
    collectSandboxReadback: vi.fn(async () => {
      calls.push("readback");
      return {
        orderId: "ord_duffel_sandbox_canary",
        observedAtIso: timestamp.done,
        liveMode: false,
        providerAccepted: true,
        orderType: "hold",
        offerId: providerTarget.offerId,
        totalCents: operationInput.totalCents,
        currency: operationInput.currency,
        passengerIds: [operationInput.passengers[0].offerPassengerId],
        awaitingPayment: true,
        paymentCount: 0,
        calendarMutationCount: 0,
        providerPayloadSha256: hash("duffel-order-payload"),
      };
    }),
    replayAuthenticatedApproval: vi.fn(async () => {
      calls.push("replay");
      return {
        replayRequestId: "duffel-replay-request",
        observedAtIso: timestamp.done,
        duplicateOrderCount: 0,
        duplicatePaymentCount: 0,
        providerStateBeforeSha256: stateSha256,
        providerStateAfterSha256: stateSha256,
      };
    }),
    executeIndependentFailureProbes: vi.fn(async () => {
      calls.push("probes");
      return probes.map((probe, index) => ({
        probeId: probe.probeId,
        failureClass:
          index === 0 ? "authorization-denied" : "provider-rejected",
        observedAtIso: timestamp.done,
        statusCode: index === 0 ? 401 : 422,
        errorCodeSha256:
          createProviderFailureProbeHashBinding(probe).expectedErrorCodeSha256,
        providerRequestIdSha256:
          index === 0 ? null : hash("duffel-rejected-request-id"),
        providerStateBeforeSha256: stateSha256,
        providerStateAfterSha256: stateSha256,
      }));
    }),
    exportDeployedTrajectory: vi.fn(async () => {
      calls.push("trajectory");
      return {
        exportId: "duffel-trajectory-export",
        exportedAtIso: timestamp.done,
        trajectoryCount: 2,
        exportSha256: hash("duffel-trajectory"),
      };
    }),
  };
  Object.defineProperty(capability, "calls", {
    value: calls,
    enumerable: false,
  });
  return capability as typeof capability & { calls: string[] };
}

describe("Duffel provider-canary operator", () => {
  it("collects a correlated hold-only sandbox receipt in fail-closed order", async () => {
    const ready = preflight();
    const external = capabilities(ready.approvalPayloadSha256);
    const receipt = await executeDuffelOperatorCanary({
      preflight: ready,
      capabilities: external,
      now: () => Date.parse(timestamp.done),
    });
    expect(receipt.qualificationClaimed).toBe(false);
    expect(receipt.readback).toMatchObject({
      liveMode: false,
      orderType: "hold",
      awaitingPayment: true,
      paymentCount: 0,
      calendarMutationCount: 0,
    });
    expect(external.calls).toEqual([
      "credential",
      "observer-begin",
      "proposal",
      "observer-complete",
      "approval",
      "readback",
      "replay",
      "probes",
      "trajectory",
    ]);
  });

  it("rejects instant order drift before any sandbox capability runs", () => {
    const raw = fixture();
    const external = capabilities(hash("unused"));
    expect(() =>
      preflightDuffelOperatorCanary({
        ...raw,
        operationInput: { ...operationInput, orderType: "instant" },
      }),
    ).toThrow(/orderType/);
    expect(external.calls).toEqual([]);
  });

  it("rejects a changed approval payload before approving or booking", async () => {
    const ready = preflight();
    const external = capabilities(ready.approvalPayloadSha256);
    external.sendAuthenticatedApprovalIngress = vi.fn(async () => ({
      requestId: "approval-ingress-request",
      acceptedAtIso: timestamp.approvalIngress,
      authenticatedPrincipalRefSha256: ownerPrincipalRefSha256,
      approvalIdSha256,
      approvalPayloadSha256: hash("substituted-price-or-passenger"),
      state: "done",
      approvedAtIso: timestamp.approved,
      doneAtIso: timestamp.done,
      providerOrderId: "ord_must_not_read",
    }));
    await expect(
      executeDuffelOperatorCanary({ preflight: ready, capabilities: external }),
    ).rejects.toThrow(/signed owner, payload, or expected state/);
    expect(external.collectSandboxReadback).not.toHaveBeenCalled();
  });

  it("refuses approval when the preapproval observer reports an order", async () => {
    const ready = preflight();
    const external = capabilities(ready.approvalPayloadSha256);
    external.beginPreapprovalNoEffectObservation = vi.fn(async () => ({
      complete: vi.fn(async () => ({
        scopeSha256,
        observationStartedAtIso: timestamp.observerStart,
        observationEndedAtIso: timestamp.observerEnd,
        providerStateBeforeSha256: stateSha256,
        providerStateAfterSha256: hash("changed-duffel-state"),
        orderCreateCount: 1,
        paymentCreateCount: 0,
      })),
    }));
    await expect(
      executeDuffelOperatorCanary({ preflight: ready, capabilities: external }),
    ).rejects.toThrow(/preapproval observer detected an effect/);
    expect(external.sendAuthenticatedApprovalIngress).not.toHaveBeenCalled();
  });

  it("rejects paid, instant, repriced, or live-mode readback", async () => {
    const ready = preflight();
    const mutations = [
      { paymentCount: 1 },
      { orderType: "instant" },
      { totalCents: operationInput.totalCents + 1 },
      { liveMode: true },
    ];
    for (const mutation of mutations) {
      const external = capabilities(ready.approvalPayloadSha256);
      const original = external.collectSandboxReadback;
      external.collectSandboxReadback = vi.fn(async (input) => ({
        ...((await original(input)) as Record<string, unknown>),
        ...mutation,
      }));
      await expect(
        executeDuffelOperatorCanary({
          preflight: ready,
          capabilities: external,
        }),
      ).rejects.toThrow(/approved payment-free hold/);
    }
  });

  it("rejects replay-created orders instead of claiming idempotency", async () => {
    const ready = preflight();
    const external = capabilities(ready.approvalPayloadSha256);
    external.replayAuthenticatedApproval = vi.fn(async () => ({
      replayRequestId: "unsafe-replay",
      observedAtIso: timestamp.done,
      duplicateOrderCount: 1,
      duplicatePaymentCount: 0,
      providerStateBeforeSha256: stateSha256,
      providerStateAfterSha256: hash("duplicate-order-state"),
    }));
    await expect(
      executeDuffelOperatorCanary({ preflight: ready, capabilities: external }),
    ).rejects.toThrow(/authenticated replay changed Duffel state/);
  });
});
