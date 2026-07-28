/**
 * Real-PGlite integration proof for the production parenting action over the
 * knowledge graph, household authorization, owner locale store, policy engine,
 * and reviewed handoff resolver. Safety results are deterministic fixtures;
 * this suite does not claim a live-model classification.
 */

import { randomUUID } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import {
  type AgentRuntime,
  createMessageMemory,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { personalAssistantPlugin } from "../../plugin.js";
import { resolveAuthenticatedFamilyPrincipal } from "../family-communications/production-wiring.js";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
  type HouseholdCoordinationService,
} from "../household/index.js";
import {
  type OwnerFactProvenanceSource,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import {
  createParentingGuidanceAction,
  PARENTING_GUIDANCE_ACTION,
} from "./action.js";
import {
  type ParentingSafetyClassification,
  type ParentingSafetyClassifier,
  registerParentingSafetyClassifier,
} from "./safety-classifier.js";
import {
  getParentingGuidanceService,
  PARENTING_AGE_BAND_ATTRIBUTE,
  PARENTING_GUIDANCE_SERVICE,
  PARENTING_RECORD_SCOPE_ATTRIBUTE,
  type ParentingGuidanceDelivery,
  ParentingGuidanceService,
} from "./service.js";
import type {
  ParentingRiskSignal,
  ParentingSafetyAssessment,
} from "./types.js";

type RiskOverrides = Partial<
  Pick<
    ParentingSafetyAssessment,
    | "immediateDanger"
    | "selfHarm"
    | "harmToOthers"
    | "suspectedAbuseOrNeglect"
    | "medicationOrDiagnosis"
    | "severeOrPersistentSymptoms"
    | "legalOrCustodyInterpretation"
  >
>;

function assessment(
  assessedAt: string,
  overrides: RiskOverrides = {},
): ParentingSafetyAssessment {
  const absent: ParentingRiskSignal = "absent";
  return {
    classifierId: "integration-parenting-classifier",
    classifierVersion: "1.0.0",
    assessedAt,
    immediateDanger: absent,
    selfHarm: absent,
    harmToOthers: absent,
    suspectedAbuseOrNeglect: absent,
    medicationOrDiagnosis: absent,
    severeOrPersistentSymptoms: absent,
    legalOrCustodyInterpretation: absent,
    ...overrides,
  };
}

class StaticSafetyClassifier implements ParentingSafetyClassifier {
  constructor(private readonly overrides: RiskOverrides) {}

  async classify(input: {
    readonly text: string;
    readonly assessedAt: string;
  }): Promise<ParentingSafetyClassification> {
    return {
      status: "classified",
      assessment: assessment(input.assessedAt, this.overrides),
    };
  }
}

describe("parenting guidance production wiring — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let household: HouseholdCoordinationService;
  const schoolAgeChildId = `ent_parenting_school_${randomUUID()}`;
  const teenChildId = `ent_parenting_teen_${randomUUID()}`;
  const ungrantedCoParentId = `ent_parenting_coparent_${randomUUID()}`;
  const action = createParentingGuidanceAction({
    resolveAuthenticatedPrincipal: resolveAuthenticatedFamilyPrincipal,
  });

  async function putChild(input: {
    entityId: string;
    ageBand: "school_age" | "teen";
    recordScope: "household_shared" | "teen_private";
  }): Promise<void> {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const now = new Date().toISOString();
    await graph.getEntityStore(runtime.agentId).upsert({
      entityId: input.entityId,
      type: "person",
      preferredName: input.entityId,
      identities: [],
      attributes: {
        [PARENTING_AGE_BAND_ATTRIBUTE]: {
          value: input.ageBand,
          confidence: 1,
          evidence: ["Owner-confirmed developmental band."],
          updatedAt: now,
        },
        [PARENTING_RECORD_SCOPE_ATTRIBUTE]: {
          value: input.recordScope,
          confidence: 1,
          evidence: ["Owner-confirmed record visibility."],
          updatedAt: now,
        },
      },
      tags: ["parenting-guidance-integration"],
      visibility: "owner_only",
      state: {},
    });
    await household.bindRole({
      entityId: input.entityId,
      role: "child",
      subjectEntityIds: [input.entityId],
      boundByEntityId: SELF_ENTITY_ID,
      evidence: "Owner confirmed the child relationship.",
    });
  }

  function ownerMessage(text: string): Memory {
    return createMessageMemory({
      id: randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: randomUUID() as UUID,
      content: { text, source: "client_chat" },
    });
  }

  async function setLocale(
    locale: string,
    options: {
      source?: OwnerFactProvenanceSource;
      recordedAt?: string;
    } = {},
  ): Promise<void> {
    await resolveOwnerFactStore(runtime).update(
      { locale },
      {
        source: options.source ?? "profile_save",
        recordedAt: options.recordedAt ?? new Date().toISOString(),
        note: "Owner confirmed locale for parenting handoff tests.",
      },
    );
  }

  function useRisk(overrides: RiskOverrides): void {
    registerParentingSafetyClassifier(
      runtime,
      new StaticSafetyClassifier(overrides),
    );
  }

  async function run(input: {
    text: string;
    childId?: string;
    topic?:
      | "boundary_setting"
      | "routines"
      | "communication"
      | "emotion_coaching"
      | "independence"
      | "positive_discipline";
    requestedFramework?: "none" | "good_inside";
    injected?: Record<string, unknown>;
  }): Promise<{
    result: Awaited<ReturnType<NonNullable<typeof action.handler>>>;
    guidance: ParentingGuidanceDelivery;
  }> {
    const result = await action.handler(
      runtime,
      ownerMessage(input.text),
      undefined,
      {
        parameters: {
          subjectEntityId: input.childId ?? schoolAgeChildId,
          topic: input.topic ?? "communication",
          requestedFramework: input.requestedFramework ?? "none",
          ...input.injected,
        },
      },
      undefined,
    );
    if (!result) throw new Error("parenting action returned no result");
    const guidance = (
      result.data as { guidance?: ParentingGuidanceDelivery } | undefined
    )?.guidance;
    if (!guidance) throw new Error("guidance artifact missing");
    return { result, guidance };
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    await graph.getEntityStore(runtime.agentId).ensureSelf();
    household =
      getHouseholdCoordinationService(runtime) ??
      createHouseholdCoordinationService(runtime);
    await putChild({
      entityId: schoolAgeChildId,
      ageBand: "school_age",
      recordScope: "household_shared",
    });
    await putChild({
      entityId: teenChildId,
      ageBand: "teen",
      recordScope: "teen_private",
    });
    await graph.getEntityStore(runtime.agentId).upsert({
      entityId: ungrantedCoParentId,
      type: "person",
      preferredName: "Ungranted co-parent test principal",
      identities: [],
      attributes: {},
      tags: ["parenting-guidance-integration"],
      visibility: "owner_only",
      state: {},
    });
    await household.bindRole({
      entityId: ungrantedCoParentId,
      role: "co_parent",
      subjectEntityIds: [schoolAgeChildId],
      boundByEntityId: SELF_ENTITY_ID,
      evidence: "Owner confirmed the co-parent relationship for access tests.",
    });
    await setLocale("en-US");
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("registers the conversational action and runtime service in production composition", () => {
    expect(
      personalAssistantPlugin.actions?.map((candidate) => candidate.name),
    ).toContain(PARENTING_GUIDANCE_ACTION);
    expect(
      personalAssistantPlugin.services?.map(
        (candidate) => candidate.serviceType,
      ),
    ).toContain(PARENTING_GUIDANCE_SERVICE);
    expect(getParentingGuidanceService(runtime)).not.toBeNull();
    expect(action.examples?.length).toBeGreaterThanOrEqual(8);
    expect(action.toolSchemaStrict).toBe(true);
    expect(action.parameters?.map((parameter) => parameter.name)).toEqual([
      "subjectEntityId",
      "ageBand",
      "topic",
      "requestedFramework",
    ]);
    expect(
      action.examples
        ?.flat()
        .map((example) => example.content.text)
        .join(" "),
    ).toMatch(/turned into a whole thing|can’t tell whether they meant it/u);
  });

  it("returns cited ordinary options and a concrete human next step from vague language", async () => {
    useRisk({});
    const { result, guidance } = await run({
      text: "Bedtime has become a whole thing lately. Give me a couple low-key things to try.",
      topic: "boundary_setting",
      requestedFramework: "good_inside",
    });

    expect(result.success).toBe(true);
    expect(guidance).toMatchObject({
      ageBand: "school_age",
      topic: "boundary_setting",
      requestedFramework: "good_inside",
      decision: {
        status: "educational_options",
        mayProvideEducationalOptions: true,
      },
      handoffResources: { status: "not_required" },
      externalEffectsPerformed: false,
    });
    expect(guidance.decision.sources.length).toBeGreaterThan(0);
    expect(
      guidance.decision.sources.some(
        (source) => source.evidenceTier === "named_framework_primary",
      ),
    ).toBe(true);
    expect(guidance.decision.frameworkNotice).toMatch(/does not impersonate/u);
    expect(guidance.decision.options.length).toBeGreaterThan(0);
    expect(guidance.humanNextStep).toMatch(/trusted caregiver/u);
    expect(result.text).toMatch(/Sources:/u);
    expect(result.text).toMatch(/Human next step:/u);
  });

  it("uses classifier output rather than injected planner safety and authorization flags", async () => {
    useRisk({});
    const { guidance } = await run({
      text: "A routine disagreement about putting the tablet away.",
      topic: "boundary_setting",
      injected: {
        safety: {
          selfHarm: "present",
          suspectedAbuseOrNeglect: "present",
        },
        privacy: { safetyDisclosureAuthorized: true },
        requester: {
          grantedScopes: ["household.subject.teen_private"],
        },
        locale: "en-US",
      },
    });

    expect(guidance.decision.status).toBe("educational_options");
    expect(guidance.decision.mayDisclosePrivateContext).toBe(true);
  });

  it("denies an ungranted household principal before child prose reaches the model classifier", async () => {
    let classifierCalls = 0;
    registerParentingSafetyClassifier(runtime, {
      classify: async ({ assessedAt }) => {
        classifierCalls += 1;
        return {
          status: "classified",
          assessment: assessment(assessedAt),
        };
      },
    });
    const deniedService = new ParentingGuidanceService({
      runtime,
      resolveAuthenticatedPrincipal: async () => ungrantedCoParentId,
    });

    await expect(
      deniedService.advise({
        message: ownerMessage(
          "Private child-related prose must not cross the model boundary.",
        ),
        subjectEntityId: schoolAgeChildId,
        topic: "communication",
      }),
    ).rejects.toMatchObject({
      code: "PARENTING_GUIDANCE_ACCESS_DENIED",
    });
    expect(classifierCalls).toBe(0);
  });

  it("stops on unknown risk instead of assuming ordinary guidance is safe", async () => {
    useRisk({ selfHarm: "unknown" });
    const { guidance } = await run({
      text: "They said something scary and I cannot tell what they meant.",
    });

    expect(guidance.decision.status).toBe("needs_safety_clarification");
    expect(guidance.decision.options).toEqual([]);
    expect(guidance.handoffResources.status).toBe("resolved");
    if (guidance.handoffResources.status !== "resolved") {
      throw new Error("precautionary resources unresolved");
    }
    expect(guidance.handoffResources.requestedKinds).toEqual([
      "emergency_services",
      "crisis_support",
    ]);
  });

  it("resolves exact US emergency and crisis resources for urgent risk", async () => {
    await setLocale("en-US");
    useRisk({ immediateDanger: "present", selfHarm: "present" });
    const { result, guidance } = await run({
      text: "My child says they are going to hurt themselves right now.",
    });

    expect(guidance.decision.status).toBe("urgent_safety_handoff");
    expect(guidance.decision.options).toEqual([]);
    expect(guidance.handoffResources.status).toBe("resolved");
    if (guidance.handoffResources.status !== "resolved") {
      throw new Error("urgent resources unresolved");
    }
    expect(
      guidance.handoffResources.resources.flatMap(
        (resource) => resource.contacts,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "911" }),
        expect.objectContaining({ value: "988" }),
      ]),
    );
    expect(result.text).not.toContain("source-grounded educational options");
  });

  it.each([
    {
      label: "abuse",
      risk: { suspectedAbuseOrNeglect: "present" } satisfies RiskOverrides,
      status: "safeguarding_handoff",
      kind: "child_safeguarding",
    },
    {
      label: "clinical or medication",
      risk: {
        medicationOrDiagnosis: "present",
        severeOrPersistentSymptoms: "present",
      } satisfies RiskOverrides,
      status: "professional_handoff",
      kind: "pediatrician_or_prescriber",
    },
    {
      label: "legal",
      risk: {
        legalOrCustodyInterpretation: "present",
      } satisfies RiskOverrides,
      status: "legal_handoff",
      kind: "qualified_legal_professional",
    },
  ] as const)(
    "routes $label language to its reviewed human boundary",
    async ({ risk, status, kind }) => {
      await setLocale("en-US");
      useRisk(risk);
      const { guidance } = await run({
        text: "The classifier fixture represents this sensitive request.",
      });

      expect(guidance.decision.status).toBe(status);
      expect(guidance.decision.options).toEqual([]);
      expect(guidance.decision.handoff?.kinds).toContain(kind);
      expect(guidance.handoffResources.status).toBe("resolved");
    },
  );

  it("withholds teen-private context even when planner flags claim disclosure authority", async () => {
    useRisk({});
    const { guidance } = await run({
      text: "Show me what the teen wrote in their private record.",
      childId: teenChildId,
      topic: "communication",
      injected: {
        privacy: {
          recordScope: "household_shared",
          subjectExplicitlyConsentedToRequester: true,
          safetyDisclosureAuthorized: true,
        },
        requester: {
          role: "owner",
          grantedScopes: ["household.subject.teen_private"],
        },
      },
    });

    expect(guidance.decision).toMatchObject({
      status: "privacy_withheld",
      mayDisclosePrivateContext: false,
      options: [],
    });
    expect(guidance.decision.omissionNotice).toMatch(/contents are omitted/u);
  });

  it("returns no guessed contacts when locale evidence is missing or unsupported", async () => {
    useRisk({ selfHarm: "present" });
    await resolveOwnerFactStore(runtime).clear();
    const missing = await run({
      text: "The child may hurt themselves now.",
    });
    expect(missing.guidance.handoffResources).toMatchObject({
      status: "unavailable",
      unavailableReason: "locale_missing",
      resources: [],
    });
    expect(missing.result.text).toMatch(/no contact was guessed/u);

    await setLocale("en-GB");
    const unsupported = await run({
      text: "The child may hurt themselves now.",
    });
    expect(unsupported.guidance.handoffResources).toMatchObject({
      status: "unavailable",
      unavailableReason: "locale_unsupported",
      resources: [],
    });
    expect(JSON.stringify(unsupported.guidance.handoffResources)).not.toContain(
      "911",
    );
    await setLocale("en-US");
  });

  it("rejects stale inferred locale and home locale during active travel", async () => {
    useRisk({ selfHarm: "present" });
    await setLocale("en-US", {
      source: "connector_inferred",
      recordedAt: "2025-01-01T00:00:00.000Z",
    });
    const stale = await run({
      text: "The child may hurt themselves now.",
    });
    expect(stale.guidance.localeEvidence).toMatchObject({
      status: "unavailable",
      unavailableReason: "locale_stale",
    });
    expect(stale.guidance.handoffResources).toMatchObject({
      status: "unavailable",
      unavailableReason: "locale_stale",
      resources: [],
    });

    await setLocale("en-US");
    const now = Date.now();
    await resolveOwnerFactStore(runtime).setActiveTravel(
      {
        startIso: new Date(now - 60_000).toISOString(),
        endIso: new Date(now + 60_000).toISOString(),
        destinationTimezone: "Europe/London",
      },
      {
        source: "profile_save",
        recordedAt: new Date(now).toISOString(),
        note: "Active travel fixture without an authoritative jurisdiction.",
      },
    );
    try {
      const inTransit = await run({
        text: "The child may hurt themselves now.",
      });
      expect(inTransit.guidance.handoffResources).toMatchObject({
        status: "unavailable",
        unavailableReason: "locale_in_transit",
        resources: [],
      });
    } finally {
      // Shared runtime state must not leak into later cases when an assertion
      // above fails.
      await resolveOwnerFactStore(runtime).setActiveTravel(null, {
        source: "profile_save",
        recordedAt: new Date().toISOString(),
        note: "Travel fixture cleanup.",
      });
    }
  });

  it("fails both guidance and handoff resources closed after their review windows", async () => {
    await setLocale("en-US");
    useRisk({});
    const staleService = new ParentingGuidanceService({
      runtime,
      now: () => new Date("2027-02-01T12:00:00.000Z"),
    });
    const guidance = await staleService.advise({
      message: ownerMessage("What can we try for this ordinary boundary?"),
      subjectEntityId: schoolAgeChildId,
      topic: "boundary_setting",
      requestedFramework: "none",
    });

    expect(guidance.decision.status).toBe("evidence_unavailable");
    expect(guidance.decision.handoff).toBeNull();
    expect(guidance.decision.options).toEqual([]);
    expect(guidance.decision.reasons.join(" ")).toMatch(
      /past their required review date/u,
    );
    expect(guidance.handoffResources).toMatchObject({
      status: "unavailable",
      unavailableReason: "resource_review_expired",
      resources: [],
    });
  });
});
