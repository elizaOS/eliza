/**
 * Resolves affected-party household approvals from connector-authenticated
 * inbound messages. The decision text is untrusted, but the sender identity
 * comes only from connector-stamped Memory metadata and must resolve to one
 * verified EntityStore identity matching the approval subject. Provider
 * message receipts make webhook redelivery and crash recovery idempotent.
 */
import { randomUUID } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import {
  ElizaError,
  getConnectorIdentityMetadataMapping,
  type IAgentRuntime,
  type Memory,
  type MessagePayload,
  normalizeConnectorSource,
} from "@elizaos/core";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalRequest,
  ApprovalRequestState,
} from "../approval-queue.types.js";
import {
  getResourceCapacityService,
  type ResourceCapacityService,
} from "../resource-capacity/service.js";
import { RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID } from "../resource-capacity/types.js";
import {
  executeRawSql,
  sqlInteger,
  sqlQuote,
  toNumber,
  toText,
} from "../sql.js";
import { createHouseholdCoordinationService } from "./service.js";
import { HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const DIRECT_CHAT_TYPES = new Set(["direct", "dm", "private"]);
// Connector quote normalization is not trustworthy enough to distinguish a
// newly typed decision from an old command whose quote marker was stripped.
// Requiring the entire trimmed body to be the taught command preserves
// whitespace-only client decoration without treating prose, signatures, or
// reflowed history as approval intent.
const MESSAGE_LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/u;

function parseApprovalCommand(
  value: string,
): HouseholdInboundApprovalCommand | null {
  let cursor = 0;
  const readWord = (): string => {
    const start = cursor;
    while (cursor < value.length && value[cursor]?.trim() !== "") cursor += 1;
    return value.slice(start, cursor);
  };
  const skipWhitespace = (): boolean => {
    const start = cursor;
    while (cursor < value.length && value[cursor]?.trim() === "") cursor += 1;
    return cursor > start;
  };
  const decision = readWord().toLowerCase();
  if ((decision !== "approve" && decision !== "reject") || !skipWhitespace())
    return null;
  if (readWord().toLowerCase() !== "household" || !skipWhitespace())
    return null;
  if (readWord().toLowerCase() !== "approval" || !skipWhitespace()) return null;
  const requestId = value.slice(cursor, cursor + 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  )
    return null;
  cursor += requestId.length;
  if (
    cursor < value.length &&
    value[cursor]?.trim() !== "" &&
    value[cursor] !== ":" &&
    value[cursor] !== "—" &&
    value[cursor] !== "-"
  ) {
    return null;
  }
  skipWhitespace();
  let reason: string | null = null;
  if (cursor < value.length) {
    if (value[cursor] !== ":" && value[cursor] !== "—" && value[cursor] !== "-")
      return null;
    cursor += 1;
    skipWhitespace();
    reason = value.slice(cursor).trimEnd();
    if (reason.length < 1 || reason.length > 500) return null;
    cursor = value.length;
  }
  return {
    decision,
    approvalRequestId: requestId.toLowerCase(),
    reason,
  };
}

export type HouseholdInboundApprovalDecision = "approve" | "reject";

export interface HouseholdInboundApprovalCommand {
  decision: HouseholdInboundApprovalDecision;
  approvalRequestId: string;
  reason: string | null;
}

export interface HouseholdAuthenticatedInboundIdentity {
  provider: string;
  connectorAccountId: string;
  providerThreadId: string;
  providerMessageId: string;
  identityClaims: Array<{ platform: string; handle: string }>;
  receivedAt: string;
}

export interface HouseholdInboundApprovalReceipt {
  id: string;
  provider: string;
  connectorAccountId: string;
  providerThreadId: string;
  providerMessageId: string;
  partyEntityId: string;
  approvalRequestId: string;
  proposalId: string;
  proposalVersion: number;
  decision: HouseholdInboundApprovalDecision;
  approvalState: ApprovalRequestState;
  receivedAt: string;
  createdAt: string;
}

export interface HouseholdInboundApprovalResult {
  status: "processed" | "duplicate" | "reconciled";
  receipt: HouseholdInboundApprovalReceipt;
}

type HouseholdApprovalTarget =
  | {
      workflow: "schedule";
      proposalId: string;
      proposalVersion: number;
      partyEntityId: string;
    }
  | {
      workflow: "resource_capacity";
      proposalId: string;
      proposalVersion: 1;
      partyEntityId: string;
      contentSha256: string;
    };

export class HouseholdInboundApprovalError extends ElizaError {
  override readonly name = "HouseholdInboundApprovalError";

  constructor(
    message: string,
    code:
      | "HOUSEHOLD_INBOUND_AMBIGUOUS_IDENTITY"
      | "HOUSEHOLD_INBOUND_INVALID_COMMAND"
      | "HOUSEHOLD_INBOUND_MISSING_IDENTITY"
      | "HOUSEHOLD_INBOUND_REPLAY_CONFLICT"
      | "HOUSEHOLD_INBOUND_SERVICE_UNAVAILABLE"
      | "HOUSEHOLD_INBOUND_STALE_APPROVAL"
      | "HOUSEHOLD_INBOUND_UNAUTHORIZED",
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity: "ephemeral",
    });
  }
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function uniqueClaims(
  claims: ReadonlyArray<{ platform: string; handle: string }>,
): Array<{ platform: string; handle: string }> {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const platform = claim.platform.trim().toLowerCase();
    const handle = claim.handle.trim().toLowerCase();
    if (!platform || !handle) return false;
    const key = `${platform}\0${handle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function identityPlatforms(provider: string): string[] {
  if (provider === "gmail" || provider === "google" || provider === "email") {
    return ["email", "gmail", "google"];
  }
  if (provider === "x" || provider === "twitter" || provider === "x_dm") {
    return ["x", "twitter"];
  }
  if (provider === "sms" || provider === "twilio") {
    return ["phone", "sms", "twilio"];
  }
  return [provider];
}

/**
 * Parse the narrow, deterministic command taught by the delivered approval
 * prompt. The full meaningful message must be that one command, because
 * connector clients may strip or reflow quote markers and thereby expose an
 * old command as an apparently unquoted line.
 */
export function parseHouseholdInboundApprovalCommand(
  text: string,
): HouseholdInboundApprovalCommand | null {
  const meaningfulText = text.trim();
  if (MESSAGE_LINE_BREAK.test(meaningfulText)) return null;
  const match = parseApprovalCommand(meaningfulText);
  if (!match) return null;
  return match;
}

/**
 * Extract only identity fields stamped by a connector into Memory metadata.
 * `content.metadata` is intentionally ignored because chat clients control it.
 */
export function authenticatedHouseholdInboundIdentity(
  message: Memory,
): HouseholdAuthenticatedInboundIdentity | null {
  const content = record(message.content);
  const metadata = record(message.metadata);
  const origin = record(metadata.origin);
  const rawProvider = firstString(
    content.source,
    metadata.provider,
    origin.provider,
  );
  const provider = normalizeConnectorSource(rawProvider) || rawProvider;
  if (
    !provider ||
    provider === "client_chat" ||
    provider === "api" ||
    provider === "sub_agent"
  ) {
    return null;
  }

  const chatType = firstString(metadata.chatType, content.channel);
  if (
    provider !== "email" &&
    provider !== "gmail" &&
    provider !== "google" &&
    (!chatType || !DIRECT_CHAT_TYPES.has(chatType.toLowerCase()))
  ) {
    return null;
  }

  const rawSource = rawProvider?.trim().toLowerCase() ?? provider;
  const nested = record(metadata[provider] ?? metadata[rawSource]);
  const sender = record(metadata.sender);
  const mapping = getConnectorIdentityMetadataMapping(provider);
  const mappedHandle = mapping
    ? firstString(metadata[mapping.userIdField])
    : null;
  const handles = [
    firstString(nested.userId, nested.id, nested.senderId, nested.contactId),
    mappedHandle,
    firstString(sender.id),
    firstString(sender.e164),
    firstString(sender.email),
    firstString(sender.username),
  ].filter((value): value is string => value !== null);
  const platforms = identityPlatforms(provider);
  const identityClaims = uniqueClaims(
    handles.flatMap((handle) =>
      platforms.map((platform) => ({ platform, handle })),
    ),
  );
  if (identityClaims.length === 0) return null;

  const thread = record(metadata.thread);
  const providerThreadId = firstString(
    nested.threadId,
    nested.chatId,
    nested.conversationId,
    thread.id,
    message.roomId,
  );
  const providerMessageId = firstString(
    nested.messageId,
    metadata.platformMessageId,
    metadata.messageIdFull,
    metadata.messageIdFirst,
  );
  const createdAt =
    typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
      ? message.createdAt
      : typeof metadata.timestamp === "number" &&
          Number.isFinite(metadata.timestamp)
        ? metadata.timestamp
        : null;
  if (!providerThreadId || !providerMessageId || createdAt === null) {
    return null;
  }
  const receivedAt = new Date(createdAt);
  if (!Number.isFinite(receivedAt.getTime())) return null;
  const connectorAccountId = firstString(nested.accountId, metadata.accountId);
  if (!connectorAccountId) return null;

  return {
    provider,
    connectorAccountId,
    providerThreadId,
    providerMessageId,
    identityClaims,
    receivedAt: receivedAt.toISOString(),
  };
}

function approvalTarget(request: ApprovalRequest): HouseholdApprovalTarget {
  if (
    request.action !== "execute_workflow" ||
    request.payload.action !== "execute_workflow"
  ) {
    throw new HouseholdInboundApprovalError(
      "The referenced approval is not a household response.",
      "HOUSEHOLD_INBOUND_INVALID_COMMAND",
      { approvalRequestId: request.id },
    );
  }
  const input = request.payload.input;
  const proposalId = input.proposalId;
  const proposalVersion = input.proposalVersion;
  const partyEntityId = input.partyEntityId;
  const commonIsInvalid =
    typeof proposalId !== "string" ||
    !proposalId.trim() ||
    typeof partyEntityId !== "string" ||
    !partyEntityId.trim();
  if (commonIsInvalid) {
    throw new HouseholdInboundApprovalError(
      "The household approval payload is malformed.",
      "HOUSEHOLD_INBOUND_INVALID_COMMAND",
      { approvalRequestId: request.id },
    );
  }
  if (
    request.payload.workflowId ===
    HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID
  ) {
    if (
      typeof proposalVersion !== "number" ||
      !Number.isInteger(proposalVersion) ||
      proposalVersion < 1
    ) {
      throw new HouseholdInboundApprovalError(
        "The household schedule approval payload is malformed.",
        "HOUSEHOLD_INBOUND_INVALID_COMMAND",
        { approvalRequestId: request.id },
      );
    }
    return {
      workflow: "schedule",
      proposalId: proposalId.trim(),
      proposalVersion,
      partyEntityId: partyEntityId.trim(),
    };
  }
  const contentSha256 = input.contentSha256;
  if (
    request.payload.workflowId !== RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID ||
    proposalVersion !== 1 ||
    typeof contentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(contentSha256) ||
    input.noExternalEffect !== true
  ) {
    throw new HouseholdInboundApprovalError(
      "The referenced approval is not a supported exact household review.",
      "HOUSEHOLD_INBOUND_INVALID_COMMAND",
      { approvalRequestId: request.id },
    );
  }
  return {
    workflow: "resource_capacity",
    proposalId: proposalId.trim(),
    proposalVersion: 1,
    partyEntityId: partyEntityId.trim(),
    contentSha256,
  };
}

function receiptFromRow(row: UnknownRecord): HouseholdInboundApprovalReceipt {
  const decision = toText(row.decision);
  const approvalState = toText(row.approval_state);
  if (
    (decision !== "approve" && decision !== "reject") ||
    ![
      "pending",
      "approved",
      "executing",
      "done",
      "rejected",
      "expired",
    ].includes(approvalState)
  ) {
    throw new HouseholdInboundApprovalError(
      "Stored household approval receipt is invalid.",
      "HOUSEHOLD_INBOUND_REPLAY_CONFLICT",
      { receiptId: toText(row.id) },
    );
  }
  return {
    id: toText(row.id),
    provider: toText(row.provider),
    connectorAccountId: toText(row.connector_account_id),
    providerThreadId: toText(row.provider_thread_id),
    providerMessageId: toText(row.provider_message_id),
    partyEntityId: toText(row.party_entity_id),
    approvalRequestId: toText(row.approval_request_id),
    proposalId: toText(row.proposal_id),
    proposalVersion: toNumber(row.proposal_version),
    decision,
    approvalState: approvalState as ApprovalRequestState,
    receivedAt: toText(row.received_at),
    createdAt: toText(row.created_at),
  };
}

async function receiptByMessage(
  runtime: IAgentRuntime,
  identity: HouseholdAuthenticatedInboundIdentity,
): Promise<HouseholdInboundApprovalReceipt | null> {
  const rows = await executeRawSql(
    runtime,
    `SELECT *
       FROM app_lifeops.life_household_inbound_approval_receipts
      WHERE agent_id = ${sqlQuote(runtime.agentId)}
        AND provider = ${sqlQuote(identity.provider)}
        AND connector_account_id = ${sqlQuote(identity.connectorAccountId)}
        AND provider_thread_id = ${sqlQuote(identity.providerThreadId)}
        AND provider_message_id = ${sqlQuote(identity.providerMessageId)}
      LIMIT 1`,
  );
  return rows[0] ? receiptFromRow(rows[0]) : null;
}

async function receiptByApproval(
  runtime: IAgentRuntime,
  approvalRequestId: string,
): Promise<HouseholdInboundApprovalReceipt | null> {
  const rows = await executeRawSql(
    runtime,
    `SELECT *
       FROM app_lifeops.life_household_inbound_approval_receipts
      WHERE agent_id = ${sqlQuote(runtime.agentId)}
        AND approval_request_id = ${sqlQuote(approvalRequestId)}
      LIMIT 1`,
  );
  return rows[0] ? receiptFromRow(rows[0]) : null;
}

function assertReceiptMatches(
  receipt: HouseholdInboundApprovalReceipt,
  command: HouseholdInboundApprovalCommand,
  partyEntityId: string,
  identity: HouseholdAuthenticatedInboundIdentity,
): void {
  if (
    receipt.approvalRequestId !== command.approvalRequestId ||
    receipt.decision !== command.decision ||
    receipt.partyEntityId !== partyEntityId ||
    receipt.provider !== identity.provider ||
    receipt.connectorAccountId !== identity.connectorAccountId ||
    receipt.providerThreadId !== identity.providerThreadId ||
    receipt.providerMessageId !== identity.providerMessageId
  ) {
    throw new HouseholdInboundApprovalError(
      "A provider message or approval request was replayed with different decision bytes.",
      "HOUSEHOLD_INBOUND_REPLAY_CONFLICT",
      {
        approvalRequestId: command.approvalRequestId,
        receiptId: receipt.id,
      },
    );
  }
}

async function persistReceipt(input: {
  runtime: IAgentRuntime;
  identity: HouseholdAuthenticatedInboundIdentity;
  command: HouseholdInboundApprovalCommand;
  target: HouseholdApprovalTarget;
  approvalState: ApprovalRequestState;
  createdAt: string;
}): Promise<HouseholdInboundApprovalReceipt> {
  await executeRawSql(
    input.runtime,
    `INSERT INTO app_lifeops.life_household_inbound_approval_receipts (
      id, agent_id, provider, connector_account_id, provider_thread_id,
      provider_message_id, party_entity_id, approval_request_id, proposal_id,
      proposal_version, decision, approval_state, received_at, created_at
    ) VALUES (
      ${sqlQuote(`hinbound_${randomUUID()}`)},
      ${sqlQuote(input.runtime.agentId)},
      ${sqlQuote(input.identity.provider)},
      ${sqlQuote(input.identity.connectorAccountId)},
      ${sqlQuote(input.identity.providerThreadId)},
      ${sqlQuote(input.identity.providerMessageId)},
      ${sqlQuote(input.target.partyEntityId)},
      ${sqlQuote(input.command.approvalRequestId)},
      ${sqlQuote(input.target.proposalId)},
      ${sqlInteger(input.target.proposalVersion)},
      ${sqlQuote(input.command.decision)},
      ${sqlQuote(input.approvalState)},
      ${sqlQuote(input.identity.receivedAt)},
      ${sqlQuote(input.createdAt)}
    )
    ON CONFLICT DO NOTHING`,
  );
  const receipt =
    (await receiptByMessage(input.runtime, input.identity)) ??
    (await receiptByApproval(input.runtime, input.command.approvalRequestId));
  if (!receipt) {
    throw new HouseholdInboundApprovalError(
      "The affected-party decision succeeded but its replay receipt was not persisted.",
      "HOUSEHOLD_INBOUND_REPLAY_CONFLICT",
      { approvalRequestId: input.command.approvalRequestId },
    );
  }
  assertReceiptMatches(
    receipt,
    input.command,
    input.target.partyEntityId,
    input.identity,
  );
  return receipt;
}

/**
 * Resolve connector-stamped claims to exactly one EntityStore person whose
 * matching identity is verified. Callers must still compare the result with
 * their own expected party or message principal.
 */
export async function resolveVerifiedHouseholdInboundEntityId(
  runtime: IAgentRuntime,
  identity: HouseholdAuthenticatedInboundIdentity,
): Promise<string> {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new HouseholdInboundApprovalError(
      "The household identity graph is unavailable.",
      "HOUSEHOLD_INBOUND_MISSING_IDENTITY",
    );
  }
  const entityStore = graph.getEntityStore(runtime.agentId);
  const matches = new Map<string, string>();
  for (const claim of identity.identityClaims) {
    const candidates = await entityStore.resolve({ identity: claim });
    for (const candidate of candidates) {
      const verified = candidate.entity.identities.some(
        (stored) =>
          stored.platform.toLowerCase() === claim.platform.toLowerCase() &&
          stored.handle.toLowerCase() === claim.handle.toLowerCase() &&
          stored.verified,
      );
      if (verified) {
        matches.set(candidate.entity.entityId, candidate.entity.entityId);
      }
    }
  }
  const entityIds = [...matches.keys()];
  if (entityIds.length === 0) {
    throw new HouseholdInboundApprovalError(
      "No verified household identity matches this connector sender.",
      "HOUSEHOLD_INBOUND_MISSING_IDENTITY",
      { provider: identity.provider },
    );
  }
  if (entityIds.length !== 1) {
    throw new HouseholdInboundApprovalError(
      "Connector sender identity resolves to more than one household entity.",
      "HOUSEHOLD_INBOUND_AMBIGUOUS_IDENTITY",
      {
        provider: identity.provider,
        matchCount: entityIds.length,
      },
    );
  }
  const entityId = entityIds[0];
  if (!entityId) {
    throw new HouseholdInboundApprovalError(
      "Verified household identity resolution returned no entity.",
      "HOUSEHOLD_INBOUND_MISSING_IDENTITY",
      { provider: identity.provider },
    );
  }
  return entityId;
}

function matchesResolvedDecision(
  request: ApprovalRequest,
  partyEntityId: string,
  decision: HouseholdInboundApprovalDecision,
): boolean {
  return (
    request.resolvedBy === partyEntityId &&
    ((decision === "approve" && request.state === "approved") ||
      (decision === "reject" && request.state === "rejected"))
  );
}

/**
 * Apply one deterministic command from a verified connector sender. If the
 * approval transition committed before a crash but its receipt did not, a
 * replay reconciles that exact resolved decision instead of attempting it
 * again.
 */
export async function processHouseholdInboundApproval(input: {
  runtime: IAgentRuntime;
  message: Memory;
  command: HouseholdInboundApprovalCommand;
  identity: HouseholdAuthenticatedInboundIdentity;
  now?: () => Date;
  resolveResourceCapacityService?: (
    runtime: IAgentRuntime,
  ) => ResourceCapacityService | null;
}): Promise<HouseholdInboundApprovalResult> {
  const partyEntityId = await resolveVerifiedHouseholdInboundEntityId(
    input.runtime,
    input.identity,
  );
  const duplicate = await receiptByMessage(input.runtime, input.identity);
  if (duplicate) {
    assertReceiptMatches(
      duplicate,
      input.command,
      partyEntityId,
      input.identity,
    );
    return { status: "duplicate", receipt: duplicate };
  }

  const approvals = createApprovalQueue(input.runtime, {
    agentId: input.runtime.agentId,
  });
  let request = await approvals.byId(
    input.command.approvalRequestId,
    partyEntityId,
  );
  if (!request) {
    throw new HouseholdInboundApprovalError(
      "The referenced household approval was not found.",
      "HOUSEHOLD_INBOUND_STALE_APPROVAL",
      { approvalRequestId: input.command.approvalRequestId },
    );
  }
  const target = approvalTarget(request);
  if (
    request.subjectUserId !== partyEntityId ||
    target.partyEntityId !== partyEntityId
  ) {
    throw new HouseholdInboundApprovalError(
      "The verified connector sender is not the subject of this approval.",
      "HOUSEHOLD_INBOUND_UNAUTHORIZED",
      {
        approvalRequestId: request.id,
        resolvedPartyEntityId: partyEntityId,
      },
    );
  }

  const existingForApproval = await receiptByApproval(
    input.runtime,
    request.id,
  );
  if (existingForApproval) {
    assertReceiptMatches(
      existingForApproval,
      input.command,
      partyEntityId,
      input.identity,
    );
    return { status: "duplicate", receipt: existingForApproval };
  }

  let status: HouseholdInboundApprovalResult["status"] = "processed";
  if (request.state !== "pending") {
    if (
      !matchesResolvedDecision(request, partyEntityId, input.command.decision)
    ) {
      throw new HouseholdInboundApprovalError(
        `The household approval is ${request.state} and cannot accept this decision.`,
        "HOUSEHOLD_INBOUND_STALE_APPROVAL",
        {
          approvalRequestId: request.id,
          approvalState: request.state,
        },
      );
    }
    status = "reconciled";
  } else {
    const pendingRequestId = request.id;
    const defaultReason =
      input.command.decision === "approve"
        ? `Approved through authenticated ${input.identity.provider} message.`
        : `Rejected through authenticated ${input.identity.provider} message.`;
    let respond: () => Promise<ApprovalRequest>;
    if (target.workflow === "resource_capacity") {
      const capacity = input.resolveResourceCapacityService
        ? input.resolveResourceCapacityService(input.runtime)
        : getResourceCapacityService(input.runtime);
      if (!capacity) {
        throw new HouseholdInboundApprovalError(
          "The household resource-capacity review service is unavailable.",
          "HOUSEHOLD_INBOUND_SERVICE_UNAVAILABLE",
          { approvalRequestId: pendingRequestId },
        );
      }
      respond = () =>
        capacity.respondToProposal({
          principalEntityId: partyEntityId,
          proposalId: target.proposalId,
          proposalVersion: target.proposalVersion,
          partyEntityId,
          approvalRequestId: pendingRequestId,
          contentSha256: target.contentSha256,
          decision: input.command.decision,
          reason: input.command.reason ?? defaultReason,
        });
    } else {
      respond = () =>
        createHouseholdCoordinationService(input.runtime).respondToProposal({
          proposalId: target.proposalId,
          proposalVersion: target.proposalVersion,
          partyEntityId,
          approvalRequestId: pendingRequestId,
          decision: input.command.decision,
          reason: input.command.reason ?? defaultReason,
        });
    }
    try {
      request = await respond();
    } catch (error) {
      // error-policy:J2 A competing identical connector delivery may win the
      // queue CAS. Re-read once and reconcile only the exact same party and
      // decision; every other terminal state remains observable.
      const current = await approvals.byId(pendingRequestId, partyEntityId);
      if (
        !current ||
        !matchesResolvedDecision(current, partyEntityId, input.command.decision)
      ) {
        throw new HouseholdInboundApprovalError(
          "The affected-party approval transition failed.",
          "HOUSEHOLD_INBOUND_STALE_APPROVAL",
          {
            approvalRequestId: pendingRequestId,
            approvalState: current?.state,
          },
          error,
        );
      }
      request = current;
      status = "reconciled";
    }
  }

  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const receipt = await persistReceipt({
    runtime: input.runtime,
    identity: input.identity,
    command: input.command,
    target,
    approvalState: request.state,
    createdAt,
  });
  return { status, receipt };
}

/** Build the plugin event handler without trusting planner-extracted identity. */
export function createHouseholdInboundApprovalMessageHandler(): (
  payload: MessagePayload,
) => Promise<void> {
  return async (payload: MessagePayload): Promise<void> => {
    const text =
      typeof payload.message.content.text === "string"
        ? payload.message.content.text
        : "";
    const command = parseHouseholdInboundApprovalCommand(text);
    if (!command) return;
    const identity = authenticatedHouseholdInboundIdentity(payload.message);
    if (!identity) {
      throw new HouseholdInboundApprovalError(
        "Household approval replies require a direct connector message with stable sender and message identity.",
        "HOUSEHOLD_INBOUND_MISSING_IDENTITY",
        { approvalRequestId: command.approvalRequestId },
      );
    }
    await processHouseholdInboundApproval({
      runtime: payload.runtime,
      message: payload.message,
      command,
      identity,
    });
  };
}
