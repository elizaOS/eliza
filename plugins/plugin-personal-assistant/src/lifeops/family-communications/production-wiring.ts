/**
 * Production identity and household-schedule adapters for family
 * communications. Runtime role attribution authenticates the caller; the
 * household graph supplies structural audience metadata without asking model
 * text to decide whether an event is safe for a child.
 */
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  authenticatedHouseholdInboundIdentity,
  HouseholdInboundApprovalError,
  resolveVerifiedHouseholdInboundEntityId,
} from "../household/inbound-approval.js";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
} from "../household/service.js";
import { HouseholdCoordinationError } from "../household/types.js";
import {
  FamilyCommunicationsError,
  type FamilyWeekItemInput,
  familySha256,
  requireFamilyText,
} from "./types.js";

export const HOUSEHOLD_CHILD_WEEK_SOURCE_REF = "household:child-week";

const EXPECTED_ACCESS_DENIAL_CODES = new Set([
  "HOUSEHOLD_ACCESS_DENIED",
  "HOUSEHOLD_GRANT_EXPIRED",
  "HOUSEHOLD_GRANT_REVOKED",
]);
const EXPECTED_IDENTITY_DENIAL_CODES = new Set([
  "HOUSEHOLD_INBOUND_AMBIGUOUS_IDENTITY",
  "HOUSEHOLD_INBOUND_MISSING_IDENTITY",
  "HOUSEHOLD_INBOUND_UNAUTHORIZED",
]);

export async function resolveAuthenticatedFamilyPrincipal(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<string | null> {
  if (await hasOwnerAccess(runtime, message)) return SELF_ENTITY_ID;
  const principalEntityId = requireFamilyText(
    message.entityId,
    "message.entityId",
    200,
  );
  const inboundIdentity = authenticatedHouseholdInboundIdentity(message);
  if (!inboundIdentity) return null;
  let verifiedInboundEntityId: string;
  try {
    verifiedInboundEntityId = await resolveVerifiedHouseholdInboundEntityId(
      runtime,
      inboundIdentity,
    );
  } catch (error) {
    // error-policy:J4 Missing, unverified, or ambiguous connector identity is
    // an explicit authentication denial; repository failures still surface.
    if (
      error instanceof HouseholdInboundApprovalError &&
      EXPECTED_IDENTITY_DENIAL_CODES.has(error.code)
    ) {
      return null;
    }
    throw error;
  }
  if (verifiedInboundEntityId !== principalEntityId) return null;
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new FamilyCommunicationsError(
      "KnowledgeGraphService is required to authenticate a household principal",
      "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
      { agentId: runtime.agentId },
    );
  }
  if (!(await graph.getEntityStore(runtime.agentId).get(principalEntityId))) {
    return null;
  }
  const household =
    getHouseholdCoordinationService(runtime) ??
    createHouseholdCoordinationService(runtime);
  const role = (await household.listRoleBindings()).find(
    (binding) => binding.entityId === principalEntityId,
  );
  if (!role) return null;
  try {
    await household.requireScope({
      principalEntityId,
      scope: "household.visibility",
    });
  } catch (error) {
    // error-policy:J4 Missing, expired, and revoked grants are ordinary
    // authentication denials; corrupt graph or repository state still throws.
    if (
      error instanceof HouseholdCoordinationError &&
      EXPECTED_ACCESS_DENIAL_CODES.has(error.code)
    ) {
      return null;
    }
    throw error;
  }
  return principalEntityId;
}

function scheduleSourceRef(input: {
  state: "proposal" | "agreement";
  proposalId: string | null;
  proposalVersion: number | null;
  agreementId: string | null;
  agreementVersion: number | null;
}): string {
  const recordId =
    input.state === "agreement" ? input.agreementId : input.proposalId;
  const version =
    input.state === "agreement"
      ? input.agreementVersion
      : input.proposalVersion;
  if (!recordId || version === null) {
    throw new FamilyCommunicationsError(
      "Household schedule export is missing its exact revision reference",
      "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
      { state: input.state },
    );
  }
  return `household-schedule:${input.state}:${recordId}:v${version}`;
}

export async function resolveTrustedChildWeekItems(input: {
  runtime: IAgentRuntime;
  principalEntityId: string;
  childEntityId: string;
  windowStartsAt: string;
  windowEndsAt: string;
  sourceRefs: readonly string[];
}): Promise<readonly FamilyWeekItemInput[]> {
  const sourceRefs = Array.from(new Set(input.sourceRefs));
  if (
    sourceRefs.length !== 1 ||
    sourceRefs[0] !== HOUSEHOLD_CHILD_WEEK_SOURCE_REF
  ) {
    throw new FamilyCommunicationsError(
      "Only the structurally scoped household child-week source is currently available",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      {
        supportedSourceRef: HOUSEHOLD_CHILD_WEEK_SOURCE_REF,
        requestedSourceRefs: sourceRefs,
      },
    );
  }
  const household =
    getHouseholdCoordinationService(input.runtime) ??
    createHouseholdCoordinationService(input.runtime);
  const exported = await household.exportFor({
    principalEntityId: input.principalEntityId,
  });
  return exported.schedules
    .filter((schedule) =>
      schedule.subjectEntityIds.includes(input.childEntityId),
    )
    .map((schedule): FamilyWeekItemInput => {
      const sourceRef = scheduleSourceRef(schedule);
      return {
        itemId: `family-week-${familySha256(sourceRef).slice(0, 32)}`,
        kind: "family_logistics",
        title: "Family schedule",
        startsAt: schedule.startAt,
        endsAt: schedule.endAt,
        location: null,
        subjectEntityIds: [input.childEntityId],
        audiencePrincipalEntityIds: [input.principalEntityId],
        visibility: "household_shared",
        dataClasses: ["family_logistics"],
        sourceRef,
      };
    });
}
