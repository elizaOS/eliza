import type {
  IAgentRuntime,
  Memory,
  ReadRangeUnit,
  ReadView,
  UUID,
} from "@elizaos/core";
/**
 * Cross-platform message triage — shared type contract.
 *
 * A MessageRef is the canonical representation of a single inbound message,
 * independent of its source platform. Adapters normalize platform-native
 * payloads into MessageRefs; the triage engine scores them; actions expose
 * them to agents.
 */

export type MessageSource =
  | "gmail"
  | "discord"
  | "telegram"
  | "twitter"
  | "imessage"
  | "whatsapp"
  | "calendly"
  | "browser_bridge";

export const ALL_MESSAGE_SOURCES: readonly MessageSource[] = [
  "gmail",
  "discord",
  "telegram",
  "twitter",
  "imessage",
  "whatsapp",
  "calendly",
  "browser_bridge",
] as const;

/**
 * Structural signals attached per message. Urgency, spam, and next-action are
 * deliberately absent — the model reading the MESSAGE action output makes
 * those judgments from the message content plus these facts (#14716).
 */
export interface TriageScore {
  /** Relationship-derived sender weight; DEFAULT_CONTACT_WEIGHT when unknown. */
  contactWeight: number;
  /** True when the user has previously replied in this message's thread. */
  userRepliedInThread: boolean;
  scoredAt: number;
}

export interface MessageParticipant {
  identifier: string;
  displayName?: string;
  contactId?: string;
}

export interface MessageRef {
  id: string;
  source: MessageSource;
  externalId: string;
  threadId?: string;
  from: MessageParticipant;
  to: Array<{ identifier: string; displayName?: string }>;
  subject?: string;
  snippet: string;
  body?: string;
  receivedAtMs: number;
  hasAttachments: boolean;
  isRead: boolean;
  triageScore?: TriageScore;
  /** Account/server scope: gmail address, discord server id, phone #, etc. */
  worldId?: string;
  /** Label/folder/channel/room/conversation id within a world. */
  channelId?: string;
  /** User/agent labels — persisted in the store and searchable. */
  tags?: string[];
  /** Connector-specific extras (also acts as an extension envelope). */
  metadata?: Record<string, unknown>;
}

export interface DraftRequest {
  source: MessageSource;
  /** Original message being replied to, if any. */
  inReplyToId?: string;
  threadId?: string;
  to: Array<{ identifier: string; displayName?: string }>;
  subject?: string;
  body: string;
  worldId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageDraftContext {
  /** Trusted executing caller; never parsed from model parameters or saved with a draft. */
  requester?: Memory;
}

export interface MessageSendContext extends MessageDraftContext {
  /** The exact canonical draft snapshot whose consent was verified by the service. */
  snapshot: DraftRequest;
}

export interface DraftRecord {
  draftId: string;
  /** Runtime agent that prepared this draft. Absent only on legacy scheduled rows. */
  agentId?: UUID;
  source: MessageSource;
  inReplyToId?: string;
  threadId?: string;
  to: Array<{ identifier: string; displayName?: string }>;
  subject?: string;
  body: string;
  preview: string;
  createdAtMs: number;
  sent: boolean;
  sentExternalId?: string;
  worldId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
  /** Set when scheduleSend has been invoked but the message hasn't gone out. */
  scheduledForMs?: number;
  scheduledId?: string;
  /**
   * Authoritative provider acceptance or durable ScheduledTask persistence
   * proof for the deferred send. The action uses this exact commit to ground
   * its user-facing confirmation.
   */
  scheduleCommit?: {
    kind: "durable" | "provider_accepted";
    id: string;
    committedAt: string;
    idempotencyKey: string;
    replayed: boolean;
  };
}

export interface ListOptions {
  /** Verified caller injected by the tool boundary; never read from model parameters. */
  requester?: Memory;
  sinceMs?: number;
  limit?: number;
  /**
   * Only unread messages count toward `limit`. An adapter that cannot filter
   * by read state may ignore it; callers still filter the result.
   */
  unreadOnly?: boolean;
  worldIds?: string[];
  channelIds?: string[];
}

export interface MessageAdapterCapabilities {
  list: boolean;
  search: boolean;
  manage: {
    archive?: boolean;
    trash?: boolean;
    spam?: boolean;
    label?: boolean;
    tag?: boolean;
    markRead?: boolean;
    unsubscribe?: boolean;
  };
  send: {
    reply?: boolean;
    new?: boolean;
    schedule?: boolean;
    /**
     * True when delivery must run inside the executing owner request (the
     * adapter authorizes against a live requester). Such drafts cannot be
     * handed to the durable deferred-send runner, which fires without one.
     */
    requiresLiveRequester?: boolean;
  };
  worlds: "single" | "multi";
  channels: "explicit" | "implicit" | "none";
}

export interface SearchMessagesFilters {
  /** Verified caller injected by the tool boundary; never read from model parameters. */
  requester?: Memory;
  sources?: MessageSource[];
  worldIds?: string[];
  channelIds?: string[];
  sender?: { identifier?: string; displayName?: string };
  /** Free-text content query — adapter or fallback in-memory match. */
  content?: string;
  /** AND-match all tags. */
  tags?: string[];
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

/** Provider-native request for one exact, bounded page of a message body. */
export interface ReadMessageRequest {
  /** Verified caller injected by the tool boundary; never read from model parameters. */
  requester?: Memory;
  messageId?: string;
  reference?: string;
  worldId?: string;
  /** Verified requester carried by the MESSAGE boundary, never model-authored continuation state. */
  requesterEntityId?: string;
  /** Current authorized room carried by the MESSAGE boundary. */
  requesterRoomId?: string;
  offset?: number;
  limit?: number;
  unit?: ReadRangeUnit;
  expectedRevision?: string;
}

/** Continuation metadata contains no provider body or native identifier. */
export interface ReadMessageControl {
  action: "read_message";
  source: MessageSource;
  reference: string;
  offset: number;
  limit: number;
  unit: ReadRangeUnit;
  expectedRevision: string;
}

export interface ReadMessageResult {
  text: string;
  readView: ReadView;
  control?: ReadMessageControl;
  /** Measured source work for bounded-read regression and operations telemetry. */
  sourceWork?: {
    headReads: number;
    segmentRows: number;
    providerRevisionReads: number;
    providerBodyFetches: number;
  };
}

export type ManageOperationKind =
  | "archive"
  | "trash"
  | "spam"
  | "mark_read"
  | "label_add"
  | "label_remove"
  | "tag_add"
  | "tag_remove"
  | "unsubscribe";

export const MANAGE_OPERATION_KINDS: readonly ManageOperationKind[] = [
  "archive",
  "trash",
  "spam",
  "mark_read",
  "label_add",
  "label_remove",
  "tag_add",
  "tag_remove",
  "unsubscribe",
] as const;

export type ManageOperation =
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "spam" }
  | { kind: "mark_read"; read: boolean }
  | { kind: "label_add"; label: string }
  | { kind: "label_remove"; label: string }
  | { kind: "tag_add"; tag: string }
  | { kind: "tag_remove"; tag: string }
  | { kind: "unsubscribe" };

export interface ManageResult {
  ok: boolean;
  /** Populated when ok=false (e.g. "not supported by adapter"). */
  reason?: string;
}

export interface MessageAdapter {
  readonly source: MessageSource;
  /** Owner/grant-scoped sources can opt out of the shared metadata cache. */
  readonly cachePolicy?: "none";
  isAvailable(runtime: IAgentRuntime): boolean;
  capabilities(): MessageAdapterCapabilities;
  listMessages(
    runtime: IAgentRuntime,
    opts: ListOptions,
  ): Promise<MessageRef[]>;
  getMessage(runtime: IAgentRuntime, id: string): Promise<MessageRef | null>;
  readMessage?(
    runtime: IAgentRuntime,
    request: ReadMessageRequest,
  ): Promise<ReadMessageResult>;
  searchMessages?(
    runtime: IAgentRuntime,
    filters: SearchMessagesFilters,
  ): Promise<MessageRef[]>;
  manageMessage?(
    runtime: IAgentRuntime,
    messageId: string,
    op: ManageOperation,
  ): Promise<ManageResult>;
  createDraft(
    runtime: IAgentRuntime,
    draft: DraftRequest,
    context?: MessageDraftContext,
  ): Promise<{ draftId: string; preview: string; snapshot?: DraftRequest }>;
  /** Run before cached send results or in-flight dispatches can be shared. */
  authorizeSend?(
    runtime: IAgentRuntime,
    requester?: Memory,
    draftId?: string,
  ): Promise<void>;
  sendDraft(
    runtime: IAgentRuntime,
    draftId: string,
    context?: MessageSendContext,
  ): Promise<{ externalId: string }>;
  scheduleSend?(
    runtime: IAgentRuntime,
    draftId: string,
    sendAtMs: number,
  ): Promise<{ scheduledId: string }>;
}

export class NotYetImplementedError extends Error {
  constructor(feature: string) {
    super(`NotYetImplemented: ${feature}`);
    this.name = "NotYetImplementedError";
  }
}
