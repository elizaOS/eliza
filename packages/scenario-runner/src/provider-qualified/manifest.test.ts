/**
 * Exercises provider-qualified manifest construction with adversarial scenario
 * definitions and mismatched production bindings; no runtime or connector is
 * mocked because this module is a pure trust-contract validator.
 */

import { createHash } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  canonicalSha256,
  createProviderQualificationManifest,
  type ProviderRunBindings,
  validateProviderQualificationManifest,
  validateProviderQualificationManifestForScenario,
} from "./manifest.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function scenario(): ScenarioDefinition {
  return {
    id: "calendar.provider.create",
    title: "Create a provider calendar event",
    domain: "calendar",
    lane: "live-only",
    executionProfile: "provider-qualified",
    evidenceScope: "provider-certification",
    isolation: "per-scenario",
    turns: [
      {
        name: "authenticated parent request",
        kind: "message",
        text: "Create the school pickup event on my connected calendar.",
        responseJudge: {
          rubric: "The response truthfully describes the provider outcome.",
          minimumScore: 0.9,
        },
      },
    ],
    finalChecks: [
      {
        type: "providerEffectObserved",
        name: "calendar-create",
        observerId: "calendar-observer",
        provider: "google-calendar",
        accountId: "parent-account",
        operation: "event-create",
        minCount: 1,
      },
      {
        type: "judgeRubric",
        name: "truthfulness",
        rubric: "The answer does not claim success without provider proof.",
        minimumScore: 0.9,
      },
    ],
  };
}

function bindings(): ProviderRunBindings {
  const accountRefSha256 = hash("parent-account");
  const connectionRefSha256 = hash("google-connection");
  return {
    runId: "run-provider-001",
    runNonce: "a".repeat(64),
    repositorySha: "b".repeat(40),
    deploymentSha: "c".repeat(64),
    trust: {
      manifestAuthorityKeyId: hash("manifest-authority-key"),
      observerSigners: [
        {
          observerId: "calendar-observer",
          keyId: hash("observer-key"),
        },
      ],
    },
    target: {
      principalRefSha256: hash("parent-principal"),
      roomRefSha256: hash("parent-room"),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "openai",
      actingModel: "gpt-5",
      judgeProvider: "independent-evaluator",
      judgeModel: "judge-model-v1",
      judgeKeyId: hash("judge-key"),
    },
    connectors: [
      {
        provider: "google-calendar",
        accountRefSha256,
        connectionRefSha256,
        environment: "provider-sandbox",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: "google-calendar",
      channel: "google-chat",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: hash("parent-principal"),
      roomRefSha256: hash("parent-room"),
      endpointOriginSha256: hash("https://ingress.example.test"),
    },
    capabilities: [
      {
        provider: "google-calendar",
        accountRefSha256,
        connectionRefSha256,
        capability: "event-create",
        authorizationGrantSha256: hash("grant"),
      },
    ],
    observationContracts: [
      {
        contractId: "calendar-create",
        kind: "provider-effect",
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "provider-sandbox",
        connectorProvider: "google-calendar",
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
  };
}

describe("createProviderQualificationManifest", () => {
  it("binds a data-only scenario deterministically to deployment and authority", () => {
    const first = createProviderQualificationManifest({
      scenario: scenario(),
      bindings: bindings(),
    });
    const second = createProviderQualificationManifest({
      scenario: scenario(),
      bindings: bindings(),
    });

    expect(first).toEqual(second);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.scenario.definitionSha256).toBe(
      canonicalSha256(scenario(), "scenario"),
    );
    expect(first.target.principalRefSha256).toBe(hash("parent-principal"));
    expect(first.trust).toEqual(bindings().trust);
    expect(first.requiredObservations).toHaveLength(1);
    expect(first.scenario.semanticCriteria).toHaveLength(2);
    expect(
      validateProviderQualificationManifest(JSON.parse(JSON.stringify(first))),
    ).toEqual(first);
    expect(
      validateProviderQualificationManifestForScenario(first, scenario()),
    ).toEqual(first);
  });

  it("rejects a valid serialized manifest when the authored scenario differs", () => {
    const definition = scenario();
    const manifest = createProviderQualificationManifest({
      scenario: definition,
      bindings: bindings(),
    });
    definition.turns[0].text = "Delete every event instead.";

    expect(() =>
      validateProviderQualificationManifestForScenario(manifest, definition),
    ).toThrow(/does not exactly match/);
  });

  it("rejects rehashed serialized manifests that bypass the builder's contract semantics", () => {
    const handBuilt = structuredClone(
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: bindings(),
      }),
    );
    (
      handBuilt.requiredObservations[0] as unknown as Record<string, unknown>
    ).kind = "attacker-defined";
    const { manifestSha256: _oldHash, ...core } = handBuilt;
    handBuilt.manifestSha256 = canonicalSha256(core, "manifest");

    expect(() => validateProviderQualificationManifest(handBuilt)).toThrow(
      /kind.*unsupported/,
    );
  });

  it.each(["readbackRequired", "idempotencyRequired"] as const)(
    "rejects provider-effect contracts that disable %s",
    (field) => {
      const unsafeBindings = structuredClone(bindings());
      const providerContract = unsafeBindings.observationContracts[0] as
        | (Record<string, unknown> & { kind: "provider-effect" })
        | undefined;
      if (providerContract?.kind !== "provider-effect") {
        throw new Error("test fixture lacks its provider-effect contract");
      }
      providerContract[field] = false;

      expect(() =>
        createProviderQualificationManifest({
          scenario: scenario(),
          bindings: unsafeBindings,
        }),
      ).toThrow(/must require provider readback and idempotency verification/);
    },
  );

  it("rejects accessors and hidden fields without invoking them", () => {
    const accessorBindings = bindings();
    let getterCalls = 0;
    Object.defineProperty(accessorBindings, "runId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "attacker-controlled-run";
      },
    });
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: accessorBindings,
      }),
    ).toThrow(/runId.*accessor/);
    expect(getterCalls).toBe(0);

    const hiddenBindings = bindings();
    Object.defineProperty(hiddenBindings.models, "toJSON", {
      enumerable: false,
      value: () => ({ actingProvider: "substituted" }),
    });
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: hiddenBindings,
      }),
    ).toThrow(/toJSON.*non-enumerable/);
  });

  it.each(["action", "api", "tick", "voice", "wait"])(
    "rejects the synthetic %s turn path",
    (kind) => {
      const definition = scenario();
      definition.turns = [
        {
          name: "forbidden direct turn",
          kind,
          text: "Do it",
        },
      ];
      expect(() =>
        createProviderQualificationManifest({
          scenario: definition,
          bindings: bindings(),
        }),
      ).toThrow(/must explicitly declare message/);
    },
  );

  it("requires explicit message turns and observer-or-semantic final checks", () => {
    const implicit = scenario();
    delete (implicit.turns[0] as { kind?: string }).kind;
    expect(() =>
      createProviderQualificationManifest({
        scenario: implicit,
        bindings: bindings(),
      }),
    ).toThrow(/explicitly declare message/);

    const inferred = scenario();
    inferred.finalChecks = [
      ...(inferred.finalChecks ?? []),
      {
        type: "actionCalled",
        actionName: "CREATE_CALENDAR_EVENT",
      },
    ];
    expect(() =>
      createProviderQualificationManifest({
        scenario: inferred,
        bindings: bindings(),
      }),
    ).toThrow(/not a trusted observer or semantic check/);
  });

  it("rejects executable assertions and non-plain RegExp matchers", () => {
    const executable = scenario();
    executable.turns = [
      {
        name: "executable assertion",
        kind: "message",
        text: "Do it",
        assertResponse: () => undefined,
      },
    ];
    expect(() =>
      createProviderQualificationManifest({
        scenario: executable,
        bindings: bindings(),
      }),
    ).toThrow(/executable or non-JSON data/);

    const regex = scenario();
    regex.turns = [
      {
        name: "regexp assertion",
        kind: "message",
        text: "Do it",
        responseIncludesAll: [/done/i],
        responseJudge: { rubric: "Truthful outcome." },
      },
    ];
    expect(() =>
      createProviderQualificationManifest({
        scenario: regex,
        bindings: bindings(),
      }),
    ).toThrow(/non-plain object/);
  });

  it.each([
    ["seed", [{ type: "advanceClock", by: "1h" }]],
    ["cleanup", [{ type: "gmailDeleteDrafts" }]],
    ["mockoon", ["calendar-mock"]],
  ] as const)("rejects harness-owned %s configuration", (field, value) => {
    const definition = scenario();
    (definition as unknown as Record<string, unknown>)[field] = [...value];
    expect(() =>
      createProviderQualificationManifest({
        scenario: definition,
        bindings: bindings(),
      }),
    ).toThrow();
  });

  it("rejects incomplete or cross-account identity bindings", () => {
    const incomplete = bindings();
    incomplete.target.principalRefSha256 = "";
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: incomplete,
      }),
    ).toThrow(/principalRefSha256/);

    const crossed = bindings();
    crossed.ingress.accountRefSha256 = hash("other-account");
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: crossed,
      }),
    ).toThrow(/must bind exactly one declared connector/);
  });

  it("requires a distinct acting and semantic-judge model identity", () => {
    const sameModel = bindings();
    sameModel.models.judgeProvider = sameModel.models.actingProvider;
    sameModel.models.judgeModel = sameModel.models.actingModel;
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: sameModel,
      }),
    ).toThrow(/must differ from the acting model/);
  });

  it("requires disjoint manifest, observer, and semantic signing keys", () => {
    const reusedAuthority = bindings();
    reusedAuthority.trust.manifestAuthorityKeyId =
      reusedAuthority.models.judgeKeyId;
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: reusedAuthority,
      }),
    ).toThrow(/pairwise disjoint/);

    const reusedObserver = bindings();
    reusedObserver.trust.observerSigners[0].keyId =
      reusedObserver.models.judgeKeyId;
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: reusedObserver,
      }),
    ).toThrow(/pairwise disjoint/);
  });

  it("rejects loose filters and contracts that do not match authored checks", () => {
    const loose = scenario();
    const trusted = loose.finalChecks?.[0];
    if (trusted?.type !== "providerEffectObserved") {
      throw new Error("fixture drift");
    }
    trusted.provider = ["google-calendar", "outlook-calendar"];
    expect(() =>
      createProviderQualificationManifest({
        scenario: loose,
        bindings: bindings(),
      }),
    ).toThrow(/one exact value/);

    const mismatch = bindings();
    const contract = mismatch.observationContracts[0];
    if (contract.kind !== "provider-effect") {
      throw new Error("fixture drift");
    }
    contract.requiredCount = 2;
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: mismatch,
      }),
    ).toThrow(/requiredCount differs/);
  });

  it("requires semantic judgment and a real provider boundary", () => {
    const noSemantic = scenario();
    noSemantic.turns = [{ name: "request", kind: "message", text: "Do it" }];
    noSemantic.finalChecks = [noSemantic.finalChecks?.[0]].filter(
      (check): check is NonNullable<typeof check> => Boolean(check),
    );
    expect(() =>
      createProviderQualificationManifest({
        scenario: noSemantic,
        bindings: bindings(),
      }),
    ).toThrow(/semantic criterion/);

    const noProvider = scenario();
    noProvider.finalChecks = [
      {
        type: "durableDraftObserved",
        name: "draft",
        observerId: "db-observer",
        provider: "draft-store",
        accountId: "parent-account",
        state: "draft",
      },
      noProvider.finalChecks?.[1] as NonNullable<
        ScenarioDefinition["finalChecks"]
      >[number],
    ];
    const noProviderBindings = bindings();
    noProviderBindings.observationContracts = [
      {
        contractId: "draft",
        kind: "durable-draft",
        observerId: "db-observer",
        sourceKind: "durable-database",
        system: "draft-store",
        environment: "provider-sandbox",
        connectorProvider: "google-calendar",
        accountRefSha256: hash("parent-account"),
        connectionRefSha256: hash("google-connection"),
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        state: "draft",
      },
    ];
    expect(() =>
      createProviderQualificationManifest({
        scenario: noProvider,
        bindings: noProviderBindings,
      }),
    ).toThrow(/provider-effect or provider-no-effect/);
  });

  it("accepts two bound calendar providers while ingress selects one account", () => {
    const definition = scenario();
    definition.finalChecks = [
      ...(definition.finalChecks ?? []),
      {
        type: "providerNoEffectObserved",
        name: "guest-availability-read",
        observerId: "outlook-observer",
        provider: "outlook-calendar",
        accountId: "guest-account",
        minCount: 1,
        intervalCoversScenario: true,
      },
    ];
    const multi = bindings();
    const guestAccount = hash("guest-account");
    const guestConnection = hash("outlook-connection");
    multi.connectors = [
      ...multi.connectors,
      {
        provider: "outlook-calendar",
        accountRefSha256: guestAccount,
        connectionRefSha256: guestConnection,
        environment: "provider-sandbox",
      },
    ];
    multi.capabilities = [
      ...multi.capabilities,
      {
        provider: "outlook-calendar",
        accountRefSha256: guestAccount,
        connectionRefSha256: guestConnection,
        capability: "availability-read",
        authorizationGrantSha256: hash("outlook-grant"),
      },
    ];
    multi.observationContracts = [
      ...multi.observationContracts,
      {
        contractId: "guest-availability-read",
        kind: "provider-no-effect",
        observerId: "outlook-observer",
        sourceKind: "provider-api",
        system: "outlook-calendar",
        environment: "provider-sandbox",
        connectorProvider: "outlook-calendar",
        accountRefSha256: guestAccount,
        connectionRefSha256: guestConnection,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "outlook-calendar",
        effectKinds: ["availability-read"],
        scopeSha256: hash("guest-window"),
        intervalCoverage: "full-scenario",
      },
    ];
    multi.trust.observerSigners = [
      ...multi.trust.observerSigners,
      {
        observerId: "outlook-observer",
        keyId: multi.trust.observerSigners[0].keyId,
      },
    ];

    const manifest = createProviderQualificationManifest({
      scenario: definition,
      bindings: multi,
    });
    expect(manifest.connectors).toHaveLength(2);
    expect(manifest.ingress.provider).toBe("google-calendar");
    expect(manifest.requiredObservations).toHaveLength(2);
  });

  it("rejects capabilities and observation contracts on undeclared bindings", () => {
    const unknownCapability = bindings();
    unknownCapability.capabilities[0].provider = "unknown-calendar";
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: unknownCapability,
      }),
    ).toThrow(/declared connector/);

    const unknownContract = bindings();
    unknownContract.observationContracts[0].connectorProvider =
      "unknown-calendar";
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: unknownContract,
      }),
    ).toThrow(/declared connector/);
  });

  it("bounds the total required observation slots", () => {
    const oversized = bindings();
    oversized.observationContracts[0].requiredCount = 257;
    expect(() =>
      createProviderQualificationManifest({
        scenario: scenario(),
        bindings: oversized,
      }),
    ).toThrow(/total requiredCount cannot exceed 256/);
  });
});
