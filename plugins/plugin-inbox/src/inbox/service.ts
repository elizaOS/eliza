/**
 * InboxService — the inbox triage back-end.
 *
 * Standalone successor to the inbox-domain logic that lived in PA's
 * `service-mixin-inbox` + `inbox/` modules. It holds its own runtime and
 * {@link InboxRepository} (raw SQL over the `app_inbox.life_inbox_triage_*`
 * tables PA still registers), classifies inbound messages with the LLM, and
 * answers the triage-queue reads the INBOX action and inboxTriage provider need.
 * It carries no dependency on `@elizaos/plugin-personal-assistant`.
 *
 * NOT here (delegated / left in PA, by design):
 *   - `getInbox` / `markInboxEntryRead` — the cached cross-channel inbox that
 *     backs `GET /api/lifeops/inbox`. It is coupled to PA's `LifeOpsRepository`
 *     inbox cache, LLM priority scoring, Gmail/X connector sources, and the
 *     app-state store, so it remains a PA service method (the route shape stays
 *     byte-identical). InboxService takes the inbound feed as input instead of
 *     pulling connectors itself.
 */

import type {
  IAgentRuntime,
  NotificationService,
  Service,
} from "@elizaos/core";
import { logger, ServiceType } from "@elizaos/core";
import type { EntityResolveCandidate } from "@elizaos/shared";
import { loadInboxTriageConfig } from "./config.ts";
import {
  type CurationDecision,
  curateEmailCandidates,
  type EmailCurationCandidate,
  type EmailCurationIdentityHook,
  type EmailCurationOutput,
  type EmailCurationPolicy,
  type EmailCurationPolicyHook,
  type EmailCurationResolvedIdentity,
} from "./email-curation.ts";
import { InboxRepository } from "./repository.ts";
import { classifyMessages } from "./triage-classifier.ts";
import type {
  InboundMessage,
  InboxTriageConfig,
  TriageClassification,
  TriageEntry,
} from "./types.ts";

const KNOWLEDGE_GRAPH_SERVICE = "eliza_knowledge_graph";

type KnowledgeGraphEntityStore = {
  resolve(input: {
    identity: { platform: string; handle: string };
  }): Promise<EntityResolveCandidate[]>;
};

type KnowledgeGraphServiceLike = Service & {
  getEntityStore(agentId?: string): KnowledgeGraphEntityStore;
};

function resolveKnowledgeGraphService(
  runtime: IAgentRuntime,
): KnowledgeGraphServiceLike | null {
  return runtime.getService<KnowledgeGraphServiceLike>(KNOWLEDGE_GRAPH_SERVICE);
}

/** Lower-cased, angle-bracket-stripped sender email, or null. */
function normalizeSenderEmail(
  candidate: EmailCurationCandidate,
): string | null {
  const raw = candidate.fromEmail ?? candidate.from;
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const value = (angle?.[1] ?? raw).trim().toLowerCase();
  const email = value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return email?.[0]?.toLowerCase() ?? null;
}

/**
 * Map a resolved knowledge-graph entity onto the engine's identity contract.
 * A `vip`-tagged entity is a VIP; any other graph person/org is a known
 * sender. Both block bulk delete (the graph deliberately tracked them).
 */
function entityToCurationIdentity(
  candidate: EntityResolveCandidate,
): EmailCurationResolvedIdentity {
  const { entity } = candidate;
  const isVip = entity.tags.some((tag) => tag.toLowerCase() === "vip");
  return {
    kind: isVip ? "vip" : "known_person",
    label: entity.preferredName,
    matchedBy: ["knowledge_graph.identity.email"],
    blockDelete: true,
    personId: entity.entityId,
  };
}

/** Project a normalized inbound message onto the engine's candidate shape. */
function toCurationCandidate(message: InboundMessage): EmailCurationCandidate {
  return {
    id: message.id,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    subject: message.channelName,
    snippet: message.snippet,
    from: message.senderName,
    ...(message.senderEmail ? { fromEmail: message.senderEmail } : {}),
    bodyText: message.text,
    receivedAt: new Date(message.timestamp).toISOString(),
  };
}

export interface TriageOptions {
  /** Override the loaded triage config (priority senders/channels, rules). */
  config?: InboxTriageConfig;
  /** Owner context string injected into the classifier prompt. */
  ownerContext?: string;
  /** How many past owner-corrected examples to few-shot the classifier with. */
  exampleLimit?: number;
  /** Skip persistence and only return the classification (default false). */
  classifyOnly?: boolean;
}

export interface TriagedMessage {
  message: InboundMessage;
  classification: TriageClassification;
  urgency: "low" | "medium" | "high";
  confidence: number;
  reasoning: string;
  suggestedResponse?: string;
  /** The persisted triage entry, unless `classifyOnly` was set. */
  entry?: TriageEntry;
}

export interface TriageRunResult {
  triaged: TriagedMessage[];
}

export interface SearchOptions {
  classification?: TriageClassification;
  limit?: number;
  unresolvedOnly?: boolean;
}

export interface CurateOptions {
  /**
   * Identity resolver. Defaults to a hook backed by the runtime
   * {@link resolveKnowledgeGraphService | knowledge-graph service}, which
   * resolves the sender's entity from the runtime graph. Injectable as a test
   * seam and to let callers override the identity source.
   */
  identityHook?: EmailCurationIdentityHook;
  /**
   * Policy hook applied after the engine's provisional decision. Defaults to a
   * no-op (the engine's built-in `DEFAULT_POLICY` thresholds and delete
   * blockers still apply). No PA-owned policy store is reachable from the
   * inbox plugin without importing PA, so there is no default policy source
   * beyond the engine's own defaults.
   */
  policyHook?: EmailCurationPolicyHook;
  /** Static policy overrides merged onto the engine defaults. */
  policy?: EmailCurationPolicy;
  /** Override the curation timestamp (defaults to engine `now`). */
  now?: string;
}

/** The curation decision attached to a triaged message. */
export interface CuratedMessage extends TriagedMessage {
  curation: CurationDecision;
}

export interface TriageWithCurationResult {
  triaged: CuratedMessage[];
  curation: EmailCurationOutput;
}

/**
 * The triage / search / list back-end for the inbox domain. One instance per
 * call is fine — the repository is a thin raw-SQL wrapper over the runtime DB.
 */
export class InboxService {
  private readonly repository: InboxRepository;

  constructor(private readonly runtime: IAgentRuntime) {
    this.repository = new InboxRepository(runtime);
  }

  getRepository(): InboxRepository {
    return this.repository;
  }

  /**
   * Classify a batch of inbound messages and (unless `classifyOnly`) persist
   * one triage entry per message. Returns the per-message decision in input
   * order. Messages already triaged by `source_message_id` are skipped so a
   * re-run does not double-store.
   */
  async triage(
    messages: InboundMessage[],
    opts: TriageOptions = {},
  ): Promise<TriageRunResult> {
    if (messages.length === 0) return { triaged: [] };

    const config = opts.config ?? loadInboxTriageConfig(this.runtime);
    const examples = opts.classifyOnly
      ? []
      : await this.repository.getExamples(opts.exampleLimit ?? 10);

    const results = await classifyMessages(this.runtime, messages, {
      config,
      examples,
      ...(opts.ownerContext ? { ownerContext: opts.ownerContext } : {}),
    });

    const triaged: TriagedMessage[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const result = results[i];
      if (!message || !result) continue;

      const triagedMessage: TriagedMessage = {
        message,
        classification: result.classification,
        urgency: result.urgency,
        confidence: result.confidence,
        reasoning: result.reasoning,
        ...(result.suggestedResponse
          ? { suggestedResponse: result.suggestedResponse }
          : {}),
      };

      if (!opts.classifyOnly) {
        const existing = message.id
          ? await this.repository.getBySourceMessageId(message.id)
          : null;
        if (existing) {
          triagedMessage.entry = existing;
        } else {
          const stored = await this.repository.storeTriage({
            source: message.source,
            ...(message.roomId ? { sourceRoomId: message.roomId } : {}),
            ...(message.entityId ? { sourceEntityId: message.entityId } : {}),
            ...(message.id ? { sourceMessageId: message.id } : {}),
            channelName: message.channelName,
            channelType: message.channelType,
            ...(message.deepLink ? { deepLink: message.deepLink } : {}),
            classification: result.classification,
            urgency: result.urgency,
            confidence: result.confidence,
            snippet: message.snippet,
            ...(message.senderName ? { senderName: message.senderName } : {}),
            ...(message.threadMessages && message.threadMessages.length > 0
              ? { threadContext: message.threadMessages }
              : {}),
            ...(result.reasoning ? { triageReasoning: result.reasoning } : {}),
            ...(result.suggestedResponse
              ? { suggestedResponse: result.suggestedResponse }
              : {}),
          });
          triagedMessage.entry = stored;
          // A newly-triaged message the user needs to act on is a home-screen
          // attention moment. Fire once per new entry (groupKey collapses) only
          // for the act-now classifications, so the inbox doesn't spam the
          // notification rail with every "info"/"notify" item (those stay
          // visible in the inbox view).
          this.notifyAttention(stored);
        }
      }

      triaged.push(triagedMessage);
    }

    return { triaged };
  }

  /**
   * Surface an act-now triage entry (`urgent` / `needs_reply`) on the home
   * notification rail. Best-effort: a runtime with no NotificationService (a
   * headless/test runtime) is a no-op. `info`/`notify`/`ignore` stay in the
   * inbox view without pushing a notification.
   */
  private notifyAttention(entry: TriageEntry): void {
    const isUrgent = entry.classification === "urgent";
    if (!isUrgent && entry.classification !== "needs_reply") return;

    const who = entry.senderName ? ` from ${entry.senderName}` : "";
    this.runtime
      .getService<NotificationService>(ServiceType.NOTIFICATION)
      ?.notify({
        title: isUrgent
          ? `Urgent message${who}`
          : `Message${who} needs a reply`,
        body: entry.snippet,
        category: "message",
        priority: isUrgent ? "urgent" : "high",
        source: "inbox",
        groupKey: `inbox:${entry.id}`,
        deepLink: entry.deepLink ?? "/inbox",
        data: {
          triageEntryId: entry.id,
          classification: entry.classification,
          channelName: entry.channelName,
        },
      })
      .catch((error: unknown) => {
        logger.debug({ src: "inbox", error }, "Triage notify failed");
      });
  }

  /**
   * Run the pure email-curation engine over a batch of inbound messages and
   * return the per-candidate decision (save / archive / delete / review with
   * evidence, citations, and a bulk-review block).
   *
   * This is the richer decision path that complements {@link triage}: triage
   * answers "how urgent is this and should I reply", curation answers "what
   * should happen to this message in the owner's mailbox". It does not persist
   * anything — callers decide what to do with the suggested action.
   *
   * The identity hook is backed by the runtime knowledge-graph service so the
   * sender's entity (VIP / known person / service) feeds the engine's
   * delete-blockers. Both hooks are injectable as a test seam.
   */
  async curate(
    messages: InboundMessage[],
    opts: CurateOptions = {},
  ): Promise<EmailCurationOutput> {
    const candidates = messages.map((message) => toCurationCandidate(message));
    // The engine's identity hook is synchronous, but the knowledge-graph read
    // is async, so we pre-resolve every candidate's identity here and hand the
    // engine a synchronous lookup over that map. An explicitly injected hook
    // wins (test seam / caller override).
    const identityHook =
      opts.identityHook ??
      (await this.buildKnowledgeGraphIdentityHook(candidates));
    return curateEmailCandidates({
      candidates,
      identityHook,
      ...(opts.policyHook ? { policyHook: opts.policyHook } : {}),
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  /**
   * Triage a batch, then attach a curation decision to each message in the
   * same input order. Triage behavior is unchanged (the existing
   * classification + persistence still runs); curation is additive.
   */
  async triageWithCuration(
    messages: InboundMessage[],
    opts: TriageOptions & CurateOptions = {},
  ): Promise<TriageWithCurationResult> {
    const { identityHook, policyHook, policy, now, ...triageOpts } = opts;
    const triageResult = await this.triage(messages, triageOpts);
    const curation = await this.curate(messages, {
      ...(identityHook ? { identityHook } : {}),
      ...(policyHook ? { policyHook } : {}),
      ...(policy ? { policy } : {}),
      ...(now ? { now } : {}),
    });

    const decisionByCandidateId = new Map(
      curation.decisions.flatMap((decision) =>
        decision.canonicalMessageIds.map((id) => [id, decision] as const),
      ),
    );

    const triaged: CuratedMessage[] = triageResult.triaged.flatMap(
      (triagedMessage) => {
        const decision = decisionByCandidateId.get(triagedMessage.message.id);
        if (!decision) return [];
        return [{ ...triagedMessage, curation: decision }];
      },
    );

    return { triaged, curation };
  }

  /**
   * Build an {@link EmailCurationIdentityHook} backed by the runtime
   * knowledge-graph service. Pre-resolves every candidate's sender against the
   * entity graph (the engine hook itself must be synchronous, so the async
   * graph reads happen here) and maps the resolved entity onto the engine's
   * identity kinds. Candidates the graph cannot resolve fall through to the
   * engine's built-in sender heuristics. When the graph service is absent the
   * hook resolves nothing.
   */
  private async buildKnowledgeGraphIdentityHook(
    candidates: readonly EmailCurationCandidate[],
  ): Promise<EmailCurationIdentityHook> {
    const kg = resolveKnowledgeGraphService(this.runtime);
    if (!kg) return () => null;
    const store = kg.getEntityStore();

    const resolved = new Map<string, EmailCurationResolvedIdentity>();
    for (const candidate of candidates) {
      const senderEmail = normalizeSenderEmail(candidate);
      if (!senderEmail) continue;
      const matches = await store.resolve({
        identity: { platform: "email", handle: senderEmail },
      });
      const best = matches[0];
      if (!best) continue;
      resolved.set(candidate.id, entityToCurationIdentity(best));
    }

    return (candidate) => resolved.get(candidate.id) ?? null;
  }

  /**
   * Read persisted triage entries, optionally filtered by classification.
   * Backs the INBOX action's `search`/`list` reads over the triage queue.
   */
  async search(opts: SearchOptions = {}): Promise<TriageEntry[]> {
    if (opts.classification) {
      return this.repository.getByClassification(opts.classification, {
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.unresolvedOnly !== undefined
          ? { unresolvedOnly: opts.unresolvedOnly }
          : {}),
      });
    }
    return this.repository.getUnresolved(
      opts.limit !== undefined ? { limit: opts.limit } : undefined,
    );
  }

  /** Unresolved triage queue (urgency-ordered). */
  async list(limit?: number): Promise<TriageEntry[]> {
    return this.repository.getUnresolved(
      limit !== undefined ? { limit } : undefined,
    );
  }

  /** Snooze a triage entry until a future ISO timestamp. */
  async snooze(id: string, snoozedUntil: string): Promise<void> {
    await this.repository.snoozeUntil(id, snoozedUntil);
  }

  /** Non-ignored triage entries created since `sinceIso`, urgency-ordered. */
  async digest(sinceIso: string): Promise<TriageEntry[]> {
    return this.repository.getRecentForDigest(sinceIso);
  }

  /** Mark a triage entry resolved (optionally recording the sent draft). */
  async resolve(
    id: string,
    opts?: { draftResponse?: string; autoReplied?: boolean },
  ): Promise<void> {
    await this.repository.markResolved(id, opts);
  }
}
