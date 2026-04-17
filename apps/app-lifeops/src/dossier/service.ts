/**
 * T7f — Meeting dossier generator (plan §6.7).
 *
 * DossierService builds a briefing payload for an upcoming calendar event.
 * It collects:
 *   1. The resolved calendar event (by id or fuzzy title match).
 *   2. Attendee enrichment via the RelationshipsService (structural).
 *   3. Recent Gmail threads for attendees whose emails match (structural).
 *   4. Prior dossiers for the same attendees (memories, tableName=reminders,
 *      content.type === "meeting_dossier").
 *   5. A well-formedness check on any meeting link (not a network fetch).
 *
 * Every external dependency is optional and the service degrades gracefully
 * to an empty list when the dependency is not registered. The returned
 * payload carries an explicit `degraded` map so downstream consumers can
 * reason about partial data — no silent fallbacks that fake completeness.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared/contracts/lifeops";

export interface DossierAttendeeSummary {
  email: string | null;
  displayName: string | null;
  contactId: UUID | null;
  categories: string[];
  tags: string[];
  lastInteractionAt: string | null;
  cadenceHealth:
    | "on-track"
    | "due"
    | "overdue"
    | "never-contacted"
    | "no-goal"
    | null;
  recentGmailThreads: DossierGmailThreadRef[];
  priorDossierMemoryIds: UUID[];
}

export interface DossierGmailThreadRef {
  threadId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: string | null;
}

export interface DossierMeetingLinkCheck {
  url: string;
  wellFormed: boolean;
  reason?: string;
}

export interface DossierPayload {
  eventId: string;
  eventTitle: string;
  eventStartAt: string;
  eventEndAt: string;
  windowDays: number;
  attendees: DossierAttendeeSummary[];
  meetingLink: DossierMeetingLinkCheck | null;
  priorDossiersCount: number;
  degraded: {
    relationships: boolean;
    gmail: boolean;
    memories: boolean;
    /**
     * True when we tried to resolve cross-platform identity clusters for
     * attendees but the service was unavailable or threw. Consumers can
     * surface "identity dedup not applied — list may include duplicates
     * of the same person across platforms".
     */
    identityCluster: boolean;
  };
  generatedAt: string;
}

export interface DossierResult {
  text: string;
  data: DossierPayload;
}

/**
 * Structural shape we depend on from the RelationshipsService. Kept local so
 * this service degrades cleanly when the service isn't registered and so we
 * don't create a circular dependency on `@elizaos/plugin-agent-skills`.
 */
export interface RelationshipsServiceLike {
  findByHandle(
    platform: string,
    identifier: string,
  ): Promise<{
    entityId: UUID;
    categories: string[];
    tags: string[];
    customFields: Record<string, unknown>;
    lastInteractionAt?: string;
  } | null>;
  getRelationshipProgress(contactId: UUID): Promise<{
    contactId: UUID;
    cadenceHealth:
      | "on-track"
      | "due"
      | "overdue"
      | "never-contacted"
      | "no-goal";
    lastInteractionAt: string | null;
    daysSinceInteraction: number | null;
    targetCadenceDays: number | null;
  } | null>;
  /** WS3: cross-platform identity-cluster lookup. Optional: older runtimes
   * may not expose it. When absent, dedup degrades to email-only. */
  resolvePrimaryEntityId?(entityId: UUID): Promise<UUID>;
}

/** Structural shape for a calendar feed provider. */
export interface CalendarFeedProviderLike {
  getCalendarFeed(
    requestUrl: URL,
    request: { timeMin?: string; timeMax?: string },
    now?: Date,
  ): Promise<LifeOpsCalendarFeed>;
}

/** Structural shape for an optional Gmail search provider. */
export interface GmailSearchProviderLike {
  searchThreadsByParticipant(input: {
    email: string;
    windowDays: number;
    maxResults?: number;
  }): Promise<DossierGmailThreadRef[]>;
}

export interface DossierServiceDeps {
  relationships?: RelationshipsServiceLike | null;
  calendar: CalendarFeedProviderLike;
  gmail?: GmailSearchProviderLike | null;
}

export interface GenerateDossierInput {
  eventId?: string;
  eventTitleFuzzy?: string;
  windowDays?: number;
}

const DEFAULT_WINDOW_DAYS = 7;
const MAX_GMAIL_THREADS_PER_ATTENDEE = 3;
const MAX_PRIOR_DOSSIER_LOOKBACK = 20;
export const DOSSIER_MEMORY_TABLE = "reminders" as const;
export const DOSSIER_MEMORY_TYPE = "meeting_dossier" as const;

export class DossierService {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly deps: DossierServiceDeps,
  ) {}

  async generateDossier(
    eventIdOrTitleFuzzy: string,
    windowDays: number = DEFAULT_WINDOW_DAYS,
  ): Promise<DossierResult> {
    const trimmed = eventIdOrTitleFuzzy.trim();
    if (trimmed.length === 0) {
      throw new Error("[DossierService] eventIdOrTitleFuzzy is required");
    }
    const effectiveWindowDays = Number.isFinite(windowDays) && windowDays > 0
      ? Math.floor(windowDays)
      : DEFAULT_WINDOW_DAYS;

    const now = new Date();
    const event = await this.resolveEvent(trimmed, now, effectiveWindowDays);
    if (!event) {
      throw new Error(
        `[DossierService] no calendar event matched "${trimmed}"`,
      );
    }

    const degraded = {
      relationships: !this.deps.relationships,
      gmail: !this.deps.gmail,
      memories: false,
      identityCluster: false,
    };

    const rawAttendees: DossierAttendeeSummary[] = [];
    for (const attendee of event.attendees) {
      const summary = await this.buildAttendeeSummary(
        attendee,
        effectiveWindowDays,
      );
      rawAttendees.push(summary);
    }

    const attendees = await this.dedupeByIdentityCluster(
      rawAttendees,
      degraded,
    );

    const priorDossierIds = new Set<UUID>();
    try {
      const memoryIdsByAttendee = await this.findPriorDossierMemoryIds(
        attendees.map((a) => a.email).filter((e): e is string => Boolean(e)),
      );
      for (const [email, ids] of memoryIdsByAttendee.entries()) {
        for (const a of attendees) {
          if (a.email && a.email.toLowerCase() === email) {
            a.priorDossierMemoryIds = ids;
          }
        }
        for (const id of ids) priorDossierIds.add(id);
      }
    } catch (err) {
      degraded.memories = true;
      logger.warn(
        `[DossierService] memory lookup failed — marking degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const meetingLink = checkMeetingLink(event.conferenceLink);

    const payload: DossierPayload = {
      eventId: event.id,
      eventTitle: event.title,
      eventStartAt: event.startAt,
      eventEndAt: event.endAt,
      windowDays: effectiveWindowDays,
      attendees,
      meetingLink,
      priorDossiersCount: priorDossierIds.size,
      degraded,
      generatedAt: now.toISOString(),
    };

    const text = renderDossierMarkdown(payload);
    return { text, data: payload };
  }

  private async resolveEvent(
    eventIdOrTitleFuzzy: string,
    now: Date,
    windowDays: number,
  ): Promise<LifeOpsCalendarEvent | null> {
    const url = new URL("internal://dossier/resolve");
    const timeMin = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
      .toISOString();
    const timeMax = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000)
      .toISOString();
    const feed = await this.deps.calendar.getCalendarFeed(
      url,
      { timeMin, timeMax },
      now,
    );
    const exact = feed.events.find(
      (e) => e.id === eventIdOrTitleFuzzy || e.externalId === eventIdOrTitleFuzzy,
    );
    if (exact) return exact;
    const lower = eventIdOrTitleFuzzy.toLowerCase();
    const byTitle = feed.events
      .map((e) => ({ e, score: fuzzyTitleScore(e.title.toLowerCase(), lower) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return byTitle[0]?.e ?? null;
  }

  private async buildAttendeeSummary(
    attendee: { email: string | null; displayName: string | null },
    _windowDays: number,
  ): Promise<DossierAttendeeSummary> {
    const summary: DossierAttendeeSummary = {
      email: attendee.email,
      displayName: attendee.displayName,
      contactId: null,
      categories: [],
      tags: [],
      lastInteractionAt: null,
      cadenceHealth: null,
      recentGmailThreads: [],
      priorDossierMemoryIds: [],
    };

    const relService = this.deps.relationships;
    if (relService && attendee.email) {
      const contact = await relService.findByHandle("email", attendee.email);
      if (contact) {
        summary.contactId = contact.entityId;
        summary.categories = contact.categories;
        summary.tags = contact.tags;
        summary.lastInteractionAt = contact.lastInteractionAt ?? null;
        const progress = await relService.getRelationshipProgress(
          contact.entityId,
        );
        if (progress) {
          summary.cadenceHealth = progress.cadenceHealth;
          summary.lastInteractionAt = progress.lastInteractionAt;
        }
      }
    }

    const gmail = this.deps.gmail;
    if (gmail && attendee.email) {
      const threads = await gmail.searchThreadsByParticipant({
        email: attendee.email,
        windowDays: _windowDays,
        maxResults: MAX_GMAIL_THREADS_PER_ATTENDEE,
      });
      summary.recentGmailThreads = threads.slice(
        0,
        MAX_GMAIL_THREADS_PER_ATTENDEE,
      );
    }

    return summary;
  }

  /**
   * Collapse attendees that belong to the same cross-platform identity
   * cluster. Two attendees with different emails may actually be the same
   * person (jill@work.com and jill.personal@gmail.com linked via discord
   * handle). Without this dedup, the dossier double-counts history and
   * presents the same person twice.
   *
   * Only attendees with a resolved contactId participate — unknown
   * attendees stay as-is.
   *
   * If the relationships service does not expose resolvePrimaryEntityId
   * we leave the list unchanged and flag degraded.identityCluster so the
   * consumer can tell the dedup was skipped.
   */
  private async dedupeByIdentityCluster(
    attendees: DossierAttendeeSummary[],
    degraded: DossierPayload["degraded"],
  ): Promise<DossierAttendeeSummary[]> {
    const relService = this.deps.relationships;
    if (!relService || typeof relService.resolvePrimaryEntityId !== "function") {
      if (attendees.some((a) => a.contactId !== null)) {
        degraded.identityCluster = true;
      }
      return attendees;
    }

    const primaryByContact = new Map<UUID, UUID>();
    for (const attendee of attendees) {
      if (!attendee.contactId) continue;
      try {
        const primary = await relService.resolvePrimaryEntityId(attendee.contactId);
        primaryByContact.set(attendee.contactId, primary);
      } catch (err) {
        degraded.identityCluster = true;
        logger.warn(
          `[DossierService] resolvePrimaryEntityId failed for ${attendee.contactId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return attendees;
      }
    }

    const seenPrimaries = new Set<UUID>();
    const deduped: DossierAttendeeSummary[] = [];
    for (const attendee of attendees) {
      if (!attendee.contactId) {
        deduped.push(attendee);
        continue;
      }
      const primary = primaryByContact.get(attendee.contactId);
      if (!primary) {
        deduped.push(attendee);
        continue;
      }
      if (seenPrimaries.has(primary)) {
        continue;
      }
      seenPrimaries.add(primary);
      deduped.push(attendee);
    }
    return deduped;
  }

  private async findPriorDossierMemoryIds(
    emails: string[],
  ): Promise<Map<string, UUID[]>> {
    const result = new Map<string, UUID[]>();
    if (emails.length === 0) return result;
    const adapter = (this.runtime as unknown as {
      adapter?: {
        getMemories?: (p: {
          agentId: string;
          tableName: string;
          count: number;
        }) => Promise<Memory[]>;
      };
    }).adapter;
    const getMemories = adapter?.getMemories;
    if (typeof getMemories !== "function") {
      throw new Error("runtime.adapter.getMemories not available");
    }
    const memories = await getMemories.call(adapter, {
      agentId: String(this.runtime.agentId),
      tableName: DOSSIER_MEMORY_TABLE,
      count: MAX_PRIOR_DOSSIER_LOOKBACK,
    });
    const normalizedEmails = new Set(emails.map((e) => e.toLowerCase()));
    for (const mem of memories) {
      const content = mem.content as { type?: unknown; attendees?: unknown };
      if (content?.type !== DOSSIER_MEMORY_TYPE) continue;
      const memAttendees = Array.isArray(content.attendees)
        ? content.attendees
        : [];
      for (const a of memAttendees) {
        if (typeof a !== "string") continue;
        const key = a.toLowerCase();
        if (!normalizedEmails.has(key)) continue;
        const existing = result.get(key) ?? [];
        existing.push(mem.id as UUID);
        result.set(key, existing);
      }
    }
    return result;
  }
}

function fuzzyTitleScore(title: string, query: string): number {
  if (!title || !query) return 0;
  if (title === query) return 100;
  if (title.includes(query)) return 50;
  const tokens = query.split(/\s+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((t) => title.includes(t)).length;
  return hits / tokens.length;
}

function checkMeetingLink(url: string | null): DossierMeetingLinkCheck | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        url,
        wellFormed: false,
        reason: `unsupported protocol ${parsed.protocol}`,
      };
    }
    return { url, wellFormed: true };
  } catch {
    return { url, wellFormed: false, reason: "unparseable URL" };
  }
}

function renderDossierMarkdown(payload: DossierPayload): string {
  const lines: string[] = [];
  lines.push(`# Meeting Dossier — ${payload.eventTitle}`);
  lines.push(`- Start: ${payload.eventStartAt}`);
  lines.push(`- End: ${payload.eventEndAt}`);
  if (payload.meetingLink) {
    const mark = payload.meetingLink.wellFormed ? "ok" : "malformed";
    lines.push(`- Meeting link: ${payload.meetingLink.url} (${mark})`);
  }
  lines.push(`- Context window: ${payload.windowDays}d`);
  if (payload.attendees.length === 0) {
    lines.push("\n## Attendees\n(none on file)");
  } else {
    lines.push("\n## Attendees");
    for (const a of payload.attendees) {
      const name = a.displayName ?? a.email ?? "(unknown)";
      lines.push(`### ${name}`);
      if (a.email) lines.push(`- Email: ${a.email}`);
      if (a.contactId) {
        lines.push(
          `- Relationship: ${a.cadenceHealth ?? "unknown"}${a.lastInteractionAt ? ` (last contacted ${a.lastInteractionAt})` : ""}`,
        );
        if (a.tags.length > 0) lines.push(`- Tags: ${a.tags.join(", ")}`);
      } else {
        lines.push("- Relationship: no contact on file");
      }
      if (a.recentGmailThreads.length > 0) {
        lines.push("- Recent email threads:");
        for (const t of a.recentGmailThreads) {
          lines.push(`  - ${t.subject ?? "(no subject)"} (${t.threadId})`);
        }
      }
      if (a.priorDossierMemoryIds.length > 0) {
        lines.push(`- Prior dossiers: ${a.priorDossierMemoryIds.length}`);
      }
    }
  }
  const degradedNotes: string[] = [];
  if (payload.degraded.relationships)
    degradedNotes.push("relationships service unavailable");
  if (payload.degraded.gmail) degradedNotes.push("gmail service unavailable");
  if (payload.degraded.memories) degradedNotes.push("memory lookup failed");
  if (payload.degraded.identityCluster)
    degradedNotes.push("cross-platform identity dedup unavailable");
  if (degradedNotes.length > 0) {
    lines.push(`\n_Degraded: ${degradedNotes.join("; ")}_`);
  }
  return lines.join("\n");
}

export function getRelationshipsServiceLike(
  runtime: IAgentRuntime,
): RelationshipsServiceLike | null {
  const service = runtime.getService("relationships");
  if (!service) return null;
  const candidate = service as unknown as Partial<RelationshipsServiceLike>;
  if (
    typeof candidate.findByHandle !== "function" ||
    typeof candidate.getRelationshipProgress !== "function"
  ) {
    return null;
  }
  return candidate as RelationshipsServiceLike;
}
