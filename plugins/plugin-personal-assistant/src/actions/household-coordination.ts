/**
 * Owner-facing orchestration for household roles, custody authority, scoped
 * grants, and approval-backed schedule proposals. Every result carries a
 * durable, no-op, or rejected effect receipt; affected-party decisions remain
 * confined to a boundary that authenticates the responding principal.
 */
import type {
  Action,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { resolveActionArgs, type SubactionsMap } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsFailedEffect,
  lifeOpsNoopEffect,
} from "../lifeops/action-effect-result.js";
import {
  getHouseholdCoordinationService,
  HOUSEHOLD_ACCESS_SCOPES,
  HOUSEHOLD_ROLES,
  type HouseholdAccessScope,
  HouseholdCoordinationError,
  type HouseholdRole,
  type HouseholdScheduleTerms,
  isHouseholdAccessScope,
  isHouseholdRole,
  normalizeScheduleTerms,
} from "../lifeops/household/index.js";

const ACTION_NAME = "HOUSEHOLD_COORDINATION";

const HOUSEHOLD_OWNER_SUBACTIONS = [
  "bind_role",
  "set_custody_authority",
  "revoke_custody_authority",
  "issue_grant",
  "revoke_grant",
  "create_proposal",
  "revise_proposal",
  "ensure_approvals",
  "finalize_proposal",
  "export",
] as const;
type HouseholdOwnerSubaction = (typeof HOUSEHOLD_OWNER_SUBACTIONS)[number];

const SUBACTIONS: SubactionsMap<HouseholdOwnerSubaction> = {
  bind_role: {
    description:
      "Bind an existing Entity to a typed household role, optionally reusing an existing relationship edge.",
    descriptionCompressed:
      "bind existing Entity household role; reuse relationship optional",
    required: ["householdId", "entityId", "role", "evidence"],
    optional: ["subjectEntityIds", "relationshipId"],
  },
  set_custody_authority: {
    description:
      "Create or revise the owner-maintained custody-authority baseline for one child and invalidate proposals pinned to older authority bytes.",
    descriptionCompressed:
      "set child custody authority baseline with revision guard",
    required: [
      "householdId",
      "childEntityId",
      "custodianEntityIds",
      "evidence",
    ],
    optional: ["relationshipId", "expectedRevisionSha256"],
  },
  revoke_custody_authority: {
    description:
      "Revoke one custody-authority baseline with an optional exact-revision guard and invalidate dependent proposals.",
    descriptionCompressed:
      "revoke custody authority baseline with revision guard",
    required: ["householdId", "relationshipId", "reason"],
    optional: ["expectedRevisionSha256"],
  },
  issue_grant: {
    description:
      "Issue explicit, optionally expiring household visibility or calendar access for role-related subjects.",
    descriptionCompressed:
      "issue scoped household/calendar grant; expiry optional",
    required: [
      "householdId",
      "principalEntityId",
      "role",
      "subjectEntityIds",
      "scopes",
    ],
    optional: ["expiresAt"],
  },
  revoke_grant: {
    description:
      "Revoke one household access grant immediately with an auditable reason.",
    descriptionCompressed: "revoke household grant immediately reason-required",
    required: ["grantId", "reason"],
  },
  create_proposal: {
    description:
      "Create immutable schedule proposal bytes and enqueue one version-pinned approval request per affected adult.",
    descriptionCompressed:
      "create immutable schedule proposal + affected-party approval requests",
    required: ["householdId", "coordinationId", "terms"],
    optional: [
      "proposalId",
      "baseAgreementVersion",
      "affectedPartyEntityIds",
      "requiredApproverEntityIds",
      "expiresAt",
    ],
  },
  revise_proposal: {
    description:
      "Append a proposal version and invalidate every approval tied to the prior bytes.",
    descriptionCompressed:
      "append proposal version; invalidate prior byte approvals",
    required: ["proposalId", "expectedVersion", "terms"],
    optional: [
      "affectedPartyEntityIds",
      "requiredApproverEntityIds",
      "expiresAt",
    ],
  },
  ensure_approvals: {
    description:
      "Idempotently repair missing approval requests for one pending proposal version.",
    descriptionCompressed:
      "idempotently ensure approval requests proposal version",
    required: ["proposalId", "proposalVersion"],
  },
  finalize_proposal: {
    description:
      "Activate an agreement only when every required party approved the exact proposal hash and agreement base.",
    descriptionCompressed:
      "activate exact-hash fully-approved agreement; no calendar write",
    required: ["proposalId", "proposalVersion"],
  },
  export: {
    description:
      "Read household state through the selected principal's current grants and redaction policy.",
    descriptionCompressed: "read principal-scoped redacted household export",
    required: ["householdId"],
    optional: ["principalEntityId"],
  },
};

function invalidContract(
  message: string,
  context?: Record<string, unknown>,
): never {
  throw new HouseholdCoordinationError(
    message,
    "HOUSEHOLD_INVALID_CONTRACT",
    context,
  );
}

function requiredText(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    return invalidContract(`${key} is required`, { key });
  }
  return value.trim();
}

function optionalText(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    return invalidContract(`${key} must be a non-empty string when provided`, {
      key,
    });
  }
  return value.trim();
}

function requiredInteger(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return invalidContract(`${key} must be a non-negative integer`, {
      key,
      value,
    });
  }
  return value;
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  if (params[key] === undefined || params[key] === null) return undefined;
  return requiredInteger(params, key);
}

function stringArray(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): string[] {
  const value = params[key];
  if (value === undefined && options.required !== true) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return invalidContract(`${key} must be an array of non-empty strings`, {
      key,
    });
  }
  return value.map((entry) => (entry as string).trim());
}

function householdRole(
  params: Record<string, unknown>,
  key: string,
): HouseholdRole {
  const value = requiredText(params, key);
  if (!isHouseholdRole(value)) {
    return invalidContract(`${key} is not a supported household role`, {
      key,
      value,
    });
  }
  return value;
}

function householdScopes(
  params: Record<string, unknown>,
  key: string,
): HouseholdAccessScope[] {
  const values = stringArray(params, key, { required: true });
  const invalid = values.filter((value) => !isHouseholdAccessScope(value));
  if (invalid.length > 0) {
    return invalidContract(`${key} contains unsupported household scopes`, {
      key,
      invalid,
    });
  }
  return values.filter(isHouseholdAccessScope);
}

function objectValue(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidContract(`${key} must be an object`, { key });
  }
  return value as Record<string, unknown>;
}

function nullableText(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    return invalidContract(`${key} must be a string when provided`, { key });
  }
  return value;
}

function scheduleTerms(
  params: Record<string, unknown>,
): HouseholdScheduleTerms {
  const raw = objectValue(params.terms, "terms");
  const custodyRaw = raw.custodyException;
  let custodyException: HouseholdScheduleTerms["custodyException"] = null;
  if (custodyRaw !== undefined && custodyRaw !== null) {
    const custody = objectValue(custodyRaw, "terms.custodyException");
    custodyException = {
      childEntityId: requiredText(custody, "childEntityId"),
      fromAt: requiredText(custody, "fromAt"),
      toAt: requiredText(custody, "toAt"),
      normalCustodianEntityId: requiredText(custody, "normalCustodianEntityId"),
      substituteCustodianEntityId: requiredText(
        custody,
        "substituteCustodianEntityId",
      ),
      authorityBaselineRelationshipId: requiredText(
        custody,
        "authorityBaselineRelationshipId",
      ),
      reason: requiredText(custody, "reason"),
    };
  }
  return normalizeScheduleTerms({
    summary: requiredText(raw, "summary"),
    startAt: requiredText(raw, "startAt"),
    endAt: requiredText(raw, "endAt"),
    timezone: requiredText(raw, "timezone"),
    childEntityIds: stringArray(raw, "childEntityIds", { required: true }),
    location: nullableText(raw, "location"),
    notes: nullableText(raw, "notes"),
    custodyException,
  });
}

function requestId(message: Memory): string {
  return message.id ?? `room:${message.roomId}`;
}

function receiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  return `${ACTION_NAME}:${operation}:${requestId(message)}:${resourceId}`;
}

function durableHouseholdEffect(input: {
  message: Memory;
  subaction: HouseholdOwnerSubaction;
  resourceKind: string;
  resourceId: string;
  version?: string;
  committedAt: string;
  artifacts?: EffectReceipt["artifacts"];
  idempotency?: EffectReceipt["idempotency"];
}): EffectReceipt {
  const operation = `lifeops.household_coordination.${input.subaction}`;
  return lifeOpsAppliedEffect({
    receiptId: receiptId(input.message, operation, input.resourceId),
    operation,
    resource: {
      kind: input.resourceKind,
      id: input.resourceId,
      ...(input.version ? { version: input.version } : {}),
    },
    artifacts: input.artifacts ?? [],
    idempotency: input.idempotency ?? { key: null, replayed: false },
    observedAt: input.committedAt,
    commit: {
      kind: "durable",
      id: input.version
        ? `${input.resourceId}:${input.version}`
        : input.resourceId,
      committedAt: input.committedAt,
    },
  });
}

function rejectedHouseholdEffect(input: {
  message: Memory;
  operation: string;
  code: string;
  retryable: boolean;
}): EffectReceipt {
  const observedAt = new Date().toISOString();
  const id = requestId(input.message);
  return lifeOpsFailedEffect({
    receiptId: receiptId(input.message, input.operation, id),
    operation: input.operation,
    resource: { kind: "runtime.message", id },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    failure: {
      code: input.code,
      retryable: input.retryable,
      acceptance: "rejected",
    },
  });
}

function coordinator(runtime: IAgentRuntime) {
  const service = getHouseholdCoordinationService(runtime);
  if (!service) {
    throw new HouseholdCoordinationError(
      "Household coordination service is not available",
      "HOUSEHOLD_INVALID_CONTRACT",
    );
  }
  return service;
}

async function runHouseholdOwnerSubaction(
  runtime: IAgentRuntime,
  message: Memory,
  subaction: HouseholdOwnerSubaction,
  params: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const service = coordinator(runtime);
  if (subaction === "bind_role") {
    const binding = await service.bindRole({
      entityId: requiredText(params, "entityId"),
      role: householdRole(params, "role"),
      householdId: requiredText(params, "householdId"),
      subjectEntityIds: stringArray(params, "subjectEntityIds"),
      relationshipId: optionalText(params, "relationshipId"),
      evidence: requiredText(params, "evidence"),
      boundByEntityId: SELF_ENTITY_ID,
    });
    const resourceId =
      binding.relationshipId ??
      `${binding.householdId}:${binding.entityId}:${binding.role}`;
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text: `Bound ${binding.entityId} as household role ${binding.role}.`,
        data: { action: subaction, binding },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.role_binding",
        resourceId,
        version: binding.updatedAt,
        committedAt: binding.updatedAt,
      }),
    );
  }

  if (subaction === "set_custody_authority") {
    const authority = await service.setCustodyAuthority({
      householdId: requiredText(params, "householdId"),
      relationshipId: optionalText(params, "relationshipId"),
      childEntityId: requiredText(params, "childEntityId"),
      custodianEntityIds: stringArray(params, "custodianEntityIds", {
        required: true,
      }),
      evidence: requiredText(params, "evidence"),
      updatedByEntityId: SELF_ENTITY_ID,
      expectedRevisionSha256: optionalText(params, "expectedRevisionSha256"),
    });
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text:
          `Set custody authority ${authority.relationshipId} revision ${authority.revision}. ` +
          "Pending proposals tied to older authority bytes are invalid.",
        data: { action: subaction, authority },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.custody_authority",
        resourceId: authority.relationshipId,
        version: authority.revisionSha256,
        committedAt: authority.updatedAt,
      }),
    );
  }

  if (subaction === "revoke_custody_authority") {
    const authority = await service.revokeCustodyAuthority({
      householdId: requiredText(params, "householdId"),
      relationshipId: requiredText(params, "relationshipId"),
      revokedByEntityId: SELF_ENTITY_ID,
      reason: requiredText(params, "reason"),
      expectedRevisionSha256: optionalText(params, "expectedRevisionSha256"),
    });
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text:
          `Revoked custody authority ${authority.relationshipId} at revision ${authority.revision}. ` +
          "Pending proposals tied to that authority are invalid.",
        data: { action: subaction, authority },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.custody_authority",
        resourceId: authority.relationshipId,
        version: authority.revisionSha256,
        committedAt: authority.updatedAt,
      }),
    );
  }

  if (subaction === "issue_grant") {
    const grant = await service.issueGrant({
      householdId: requiredText(params, "householdId"),
      principalEntityId: requiredText(params, "principalEntityId"),
      role: householdRole(params, "role"),
      subjectEntityIds: stringArray(params, "subjectEntityIds", {
        required: true,
      }),
      scopes: householdScopes(params, "scopes"),
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: optionalText(params, "expiresAt"),
    });
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text: `Issued household grant ${grant.id} with ${grant.scopes.join(", ")}.`,
        data: { action: subaction, grant },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.access_grant",
        resourceId: grant.id,
        version: grant.updatedAt,
        committedAt: grant.updatedAt,
      }),
    );
  }

  if (subaction === "revoke_grant") {
    const grant = await service.revokeGrant({
      grantId: requiredText(params, "grantId"),
      revokedByEntityId: SELF_ENTITY_ID,
      reason: requiredText(params, "reason"),
    });
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text: `Revoked household grant ${grant.id}.`,
        data: { action: subaction, grant },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.access_grant",
        resourceId: grant.id,
        version: grant.updatedAt,
        committedAt: grant.updatedAt,
      }),
    );
  }

  if (subaction === "create_proposal") {
    const proposal = await service.createProposal({
      householdId: requiredText(params, "householdId"),
      proposalId: optionalText(params, "proposalId"),
      coordinationId: requiredText(params, "coordinationId"),
      terms: scheduleTerms(params),
      affectedPartyEntityIds: stringArray(params, "affectedPartyEntityIds"),
      requiredApproverEntityIds: stringArray(
        params,
        "requiredApproverEntityIds",
      ),
      createdByEntityId: SELF_ENTITY_ID,
      baseAgreementVersion: optionalInteger(params, "baseAgreementVersion"),
      expiresAt: optionalText(params, "expiresAt"),
    });
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text:
          `Created household proposal ${proposal.proposalId} v${proposal.version} ` +
          `and queued ${proposal.requiredApproverEntityIds.length} separate approval request(s). ` +
          "No calendar event or external message was created.",
        data: { action: subaction, proposal },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.schedule_proposal",
        resourceId: proposal.proposalId,
        version: `${proposal.version}:${proposal.contentSha256}`,
        committedAt: proposal.updatedAt,
      }),
    );
  }

  if (subaction === "revise_proposal") {
    const proposal = await service.reviseProposal({
      proposalId: requiredText(params, "proposalId"),
      expectedVersion: requiredInteger(params, "expectedVersion"),
      terms: scheduleTerms(params),
      affectedPartyEntityIds: stringArray(params, "affectedPartyEntityIds"),
      requiredApproverEntityIds: stringArray(
        params,
        "requiredApproverEntityIds",
      ),
      revisedByEntityId: SELF_ENTITY_ID,
      expiresAt: optionalText(params, "expiresAt"),
    });
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text:
          `Created household proposal ${proposal.proposalId} v${proposal.version}; ` +
          "approvals for every prior version are invalid. No calendar event or external message was created.",
        data: { action: subaction, proposal },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.schedule_proposal",
        resourceId: proposal.proposalId,
        version: `${proposal.version}:${proposal.contentSha256}`,
        committedAt: proposal.updatedAt,
      }),
    );
  }

  if (subaction === "ensure_approvals") {
    const proposalId = requiredText(params, "proposalId");
    const proposalVersion = requiredInteger(params, "proposalVersion");
    const approvals = await service.ensureProposalApprovals(
      proposalId,
      proposalVersion,
    );
    const newestApproval = approvals.reduce<
      (typeof approvals)[number] | undefined
    >(
      (newest, approval) =>
        !newest || approval.updatedAt > newest.updatedAt ? approval : newest,
      undefined,
    );
    if (!newestApproval) {
      return invalidContract(
        "A pending household proposal must have at least one persisted approval request",
        { proposalId, proposalVersion },
      );
    }
    const approvalIds = approvals
      .map((approval) => approval.id)
      .sort()
      .join(",");
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text: `Proposal ${proposalId} v${proposalVersion} has ${approvals.length} approval request(s).`,
        data: { action: subaction, proposalId, proposalVersion, approvals },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.proposal_approvals",
        resourceId: `${proposalId}:${proposalVersion}`,
        version: approvalIds,
        committedAt: newestApproval.updatedAt,
        artifacts: approvals.map((approval) => ({
          kind: "lifeops.approval_request",
          id: approval.approvalRequestId,
          version: approval.updatedAt,
        })),
        idempotency: { key: null, replayed: false },
      }),
    );
  }

  if (subaction === "finalize_proposal") {
    const agreement = await service.finalizeProposal({
      proposalId: requiredText(params, "proposalId"),
      proposalVersion: requiredInteger(params, "proposalVersion"),
    });
    return await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text:
          `Activated household agreement ${agreement.id} v${agreement.version}. ` +
          "This records the approved commitment; it does not create or update a calendar event.",
        data: { action: subaction, agreement },
      },
      durableHouseholdEffect({
        message,
        subaction,
        resourceKind: "lifeops.household.schedule_agreement",
        resourceId: agreement.id,
        version: String(agreement.version),
        committedAt: agreement.createdAt,
        artifacts: [
          {
            kind: "lifeops.household.schedule_proposal",
            id: agreement.proposalId,
            version: String(agreement.proposalVersion),
          },
        ],
      }),
    );
  }

  const principalEntityId =
    optionalText(params, "principalEntityId") ?? SELF_ENTITY_ID;
  const exportHouseholdId = requiredText(params, "householdId");
  // Pulling the export artifact for another principal is its own granted,
  // revocable authority; internal scoped views do not pass through here.
  if (principalEntityId !== SELF_ENTITY_ID) {
    await service.requireScope({
      householdId: exportHouseholdId,
      principalEntityId,
      scope: "household.export",
    });
  }
  const householdExport = await service.exportFor({
    householdId: exportHouseholdId,
    principalEntityId,
  });
  const operation = "lifeops.household_coordination.export";
  return await completeLifeOpsEffect(
    callback,
    {
      success: true,
      text:
        `Exported ${householdExport.schedules.length} visible household schedule item(s) ` +
        `for ${principalEntityId} under ${householdExport.effectiveScopes.length} effective scope(s).`,
      data: { action: subaction, export: householdExport },
    },
    lifeOpsNoopEffect({
      receiptId: receiptId(
        message,
        operation,
        `${householdExport.householdId}:${principalEntityId}`,
      ),
      operation,
      resource: {
        kind: "lifeops.household.scoped_export",
        id: `${householdExport.householdId}:${principalEntityId}`,
        version: householdExport.generatedAt,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: householdExport.generatedAt,
      reason:
        "The operation read a principal-scoped household projection without changing household commitments.",
    }),
  );
}

const TERMS_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: { type: "string" as const, minLength: 1 },
    startAt: { type: "string" as const, minLength: 1 },
    endAt: { type: "string" as const, minLength: 1 },
    timezone: { type: "string" as const, minLength: 1 },
    childEntityIds: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
    },
    location: { type: "string" as const },
    notes: { type: "string" as const },
    custodyException: {
      type: "object" as const,
      properties: {
        childEntityId: { type: "string" as const, minLength: 1 },
        fromAt: { type: "string" as const, minLength: 1 },
        toAt: { type: "string" as const, minLength: 1 },
        normalCustodianEntityId: {
          type: "string" as const,
          minLength: 1,
        },
        substituteCustodianEntityId: {
          type: "string" as const,
          minLength: 1,
        },
        authorityBaselineRelationshipId: {
          type: "string" as const,
          minLength: 1,
        },
        reason: { type: "string" as const, minLength: 1 },
      },
      required: [
        "childEntityId",
        "fromAt",
        "toAt",
        "normalCustodianEntityId",
        "substituteCustodianEntityId",
        "authorityBaselineRelationshipId",
        "reason",
      ],
      additionalProperties: false,
    },
  },
  required: ["summary", "startAt", "endAt", "timezone", "childEntityIds"],
  additionalProperties: false,
};

const STRING_ARRAY_SCHEMA = {
  type: "array" as const,
  items: { type: "string" as const, minLength: 1 },
};

export const householdCoordinationAction: Action = {
  name: ACTION_NAME,
  similes: [
    "HOUSEHOLD",
    "FAMILY_COORDINATION",
    "CO_PARENT_COORDINATION",
    "CAREGIVER_ACCESS",
    "HOUSEHOLD_AGREEMENT",
  ],
  tags: [
    "domain:calendar",
    "domain:contacts",
    "capability:read",
    "capability:write",
    "capability:update",
    "effect:receipt-required",
    "surface:internal",
  ],
  description:
    "Owner household coordination: bind roles, set/revoke custody authority, issue/revoke scoped grants, create/revise exact-hash schedule proposals, repair approval requests, finalize fully approved agreements, and inspect redacted exports. Affected-party approval responses are not owner operations.",
  descriptionCompressed:
    "household roles|custody authority|grants|proposal versions|approval repair|agreement finalize|scoped export; no party impersonation",
  routingHint:
    "household role/access/proposal/agreement -> HOUSEHOLD_COORDINATION; calendar event CRUD -> CALENDAR; never use this owner action to answer for another affected party",
  contexts: ["general", "calendar", "contacts", "tasks", "admin"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  toolSchemaStrict: false,
  validate: async (runtime: IAgentRuntime, message: Memory) =>
    await hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description: "Household coordination operation.",
      required: true,
      schema: {
        type: "string",
        enum: [...HOUSEHOLD_OWNER_SUBACTIONS],
      },
    },
    {
      name: "householdId",
      description:
        "Canonical household namespace for role, grant, authority, proposal, and export authorization.",
      subactions: [
        "bind_role",
        "set_custody_authority",
        "revoke_custody_authority",
        "issue_grant",
        "create_proposal",
        "export",
      ],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "entityId",
      description: "Existing EntityStore entity to bind.",
      subactions: ["bind_role"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "role",
      description: "Typed household role.",
      subactions: ["bind_role", "issue_grant"],
      schema: { type: "string", enum: [...HOUSEHOLD_ROLES] },
    },
    {
      name: "subjectEntityIds",
      description:
        "Household subjects, usually child Entity ids, inside this relationship or grant.",
      subactions: ["bind_role", "issue_grant"],
      schema: STRING_ARRAY_SCHEMA,
    },
    {
      name: "relationshipId",
      description:
        "Existing relationship edge to annotate, revise as custody authority, or revoke.",
      subactions: [
        "bind_role",
        "set_custody_authority",
        "revoke_custody_authority",
      ],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "evidence",
      description:
        "Owner-supplied evidence for a role binding or custody-authority baseline.",
      subactions: ["bind_role", "set_custody_authority"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "childEntityId",
      description:
        "Child Entity whose custody-authority baseline is being set.",
      subactions: ["set_custody_authority"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "custodianEntityIds",
      description:
        "Owner and child-scoped co-parent Entity ids authorized by the custody baseline.",
      subactions: ["set_custody_authority"],
      schema: STRING_ARRAY_SCHEMA,
    },
    {
      name: "expectedRevisionSha256",
      description:
        "Optional exact current custody-authority revision hash for compare-and-swap protection.",
      subactions: ["set_custody_authority", "revoke_custody_authority"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "principalEntityId",
      description:
        "Entity receiving a grant or principal whose scoped export is requested; export defaults to owner.",
      subactions: ["issue_grant", "export"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "scopes",
      description: "Explicit household/calendar access scopes.",
      subactions: ["issue_grant"],
      schema: {
        type: "array",
        items: { type: "string", enum: [...HOUSEHOLD_ACCESS_SCOPES] },
      },
    },
    {
      name: "expiresAt",
      description: "Optional future ISO-8601 expiry.",
      subactions: ["issue_grant", "create_proposal", "revise_proposal"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "grantId",
      description: "Access grant id to revoke.",
      subactions: ["revoke_grant"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "reason",
      description: "Auditable grant or custody-authority revocation reason.",
      subactions: ["revoke_grant", "revoke_custody_authority"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "coordinationId",
      description:
        "Stable logical schedule coordination id shared by competing/revised proposals.",
      subactions: ["create_proposal"],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "proposalId",
      description:
        "Proposal logical id; optional on create and required for later operations.",
      subactions: [
        "create_proposal",
        "revise_proposal",
        "ensure_approvals",
        "finalize_proposal",
      ],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "baseAgreementVersion",
      description:
        "Expected current agreement version; defaults to the current coordination head.",
      subactions: ["create_proposal"],
      schema: { type: "integer", minimum: 0 },
    },
    {
      name: "expectedVersion",
      description: "Current proposal version expected before revision.",
      subactions: ["revise_proposal"],
      schema: { type: "integer", minimum: 1 },
    },
    {
      name: "proposalVersion",
      description: "Exact immutable proposal version.",
      subactions: ["ensure_approvals", "finalize_proposal"],
      schema: { type: "integer", minimum: 1 },
    },
    {
      name: "terms",
      description:
        "Schedule interval, timezone, household subjects, private details, and optional custody exception.",
      subactions: ["create_proposal", "revise_proposal"],
      schema: TERMS_SCHEMA,
    },
    {
      name: "affectedPartyEntityIds",
      description:
        "Additional affected Entity ids; child ids and required approvers are included automatically.",
      subactions: ["create_proposal", "revise_proposal"],
      schema: STRING_ARRAY_SCHEMA,
    },
    {
      name: "requiredApproverEntityIds",
      description:
        "Every adult whose exact approval is required; custody exception custodians are included automatically.",
      subactions: ["create_proposal", "revise_proposal"],
      schema: STRING_ARRAY_SCHEMA,
    },
  ],
  handler: async (runtime, message, state, options, callback) => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return await completeLifeOpsEffect(
        callback,
        {
          success: false,
          text: "Household coordination actions are restricted to the owner.",
          data: { error: "PERMISSION_DENIED" },
        },
        rejectedHouseholdEffect({
          message,
          operation: "lifeops.household_coordination.authorize",
          code: "PERMISSION_DENIED",
          retryable: false,
        }),
      );
    }
    const resolved = await resolveActionArgs<
      HouseholdOwnerSubaction,
      Record<string, unknown>
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      return await completeLifeOpsEffect(
        callback,
        {
          success: false,
          text: resolved.clarification,
          data: {
            error: "MISSING_HOUSEHOLD_PARAMETERS",
            missing: resolved.missing,
          },
        },
        rejectedHouseholdEffect({
          message,
          operation: "lifeops.household_coordination.resolve_request",
          code: "MISSING_HOUSEHOLD_PARAMETERS",
          retryable: true,
        }),
      );
    }
    return await runHouseholdOwnerSubaction(
      runtime,
      message,
      resolved.subaction,
      resolved.params,
      callback,
    );
  },
  examples: [],
};
