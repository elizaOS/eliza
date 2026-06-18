/**
 * InboxService — the inbox triage back-end.
 *
 * Standalone successor to the inbox-domain logic that lived in PA's
 * `service-mixin-inbox` + `inbox/` modules. It holds its own runtime and
 * {@link InboxRepository} (raw SQL over the `app_lifeops.life_inbox_triage_*`
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

import type { IAgentRuntime } from "@elizaos/core";
import { loadInboxTriageConfig } from "./config.ts";
import { InboxRepository } from "./repository.ts";
import { classifyMessages } from "./triage-classifier.ts";
import type {
  InboundMessage,
  InboxTriageConfig,
  TriageClassification,
  TriageEntry,
} from "./types.ts";

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

    const config = opts.config ?? loadInboxTriageConfig();
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
        triagedMessage.entry =
          existing ??
          (await this.repository.storeTriage({
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
          }));
      }

      triaged.push(triagedMessage);
    }

    return { triaged };
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
