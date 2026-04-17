// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import { ModelType } from "@elizaos/core";
import type { LifeOpsDossier } from "@elizaos/shared/contracts/lifeops";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function isoNow(): string {
  return new Date().toISOString();
}

type GenerateDossierInput = {
  subject: string;
  calendarEventId?: string | null;
  attendeeHandles?: string[];
  extraContextMd?: string;
  generatedForAt?: string;
};

type DossierSource = {
  kind: string;
  ref: string;
  snippet?: string;
};

const MAX_INTERACTIONS_PER_ATTENDEE = 5;
const MAX_BRIEFING_WORDS = 500;

/** @internal */
export function withDossier<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsDossierServiceMixin extends Base {
    async generateDossier(
      input: GenerateDossierInput,
    ): Promise<LifeOpsDossier> {
      const now = isoNow();
      const generatedForAt = input.generatedForAt ?? now;
      const sources: DossierSource[] = [];
      const contextSections: string[] = [];

      contextSections.push(`# Subject\n${input.subject.trim()}`);
      contextSections.push(`# Generated For\n${generatedForAt}`);

      // 1. Calendar event (if available)
      let calendarEvent: unknown = null;
      if (input.calendarEventId) {
        if (typeof (this as any).getCalendarEventById === "function") {
          try {
            calendarEvent = await (this as any).getCalendarEventById(
              input.calendarEventId,
            );
          } catch {
            calendarEvent = null;
          }
        }
        if (
          !calendarEvent &&
          typeof (this as any).repository?.getCalendarEvent === "function"
        ) {
          try {
            calendarEvent = await (this as any).repository.getCalendarEvent(
              this.agentId(),
              input.calendarEventId,
            );
          } catch {
            calendarEvent = null;
          }
        }
        if (calendarEvent) {
          sources.push({
            kind: "calendar_event",
            ref: input.calendarEventId,
            snippet: summarizeCalendarEvent(calendarEvent),
          });
          contextSections.push(
            `# Calendar Event\n${summarizeCalendarEvent(calendarEvent)}`,
          );
        } else {
          sources.push({
            kind: "calendar_event",
            ref: input.calendarEventId,
            snippet: "(event not found)",
          });
        }
      }

      // 2. Attendee relationships + interactions
      const attendeeBlocks: string[] = [];
      const handles = Array.isArray(input.attendeeHandles)
        ? input.attendeeHandles.filter((h) => typeof h === "string" && h.trim())
        : [];

      if (
        handles.length > 0 &&
        typeof (this as any).listRelationships === "function"
      ) {
        let relationships: any[] = [];
        try {
          relationships = (await (this as any).listRelationships({})) ?? [];
        } catch {
          relationships = [];
        }

        for (const handle of handles) {
          const normalized = handle.trim().toLowerCase();
          const rel = relationships.find((r: any) => {
            if (!r) return false;
            const fields = [r.primaryHandle, r.email, r.phone, r.name].filter(
              (v) => typeof v === "string",
            );
            return fields.some((v) => v.toLowerCase() === normalized);
          });

          if (!rel) {
            attendeeBlocks.push(`## ${handle}\n(no relationship on file)`);
            sources.push({
              kind: "attendee",
              ref: handle,
              snippet: "(no relationship on file)",
            });
            continue;
          }

          const lines: string[] = [];
          lines.push(`## ${rel.name ?? handle}`);
          lines.push(
            `- Channel: ${rel.primaryChannel ?? "?"} (${rel.primaryHandle ?? handle})`,
          );
          if (rel.relationshipType) {
            lines.push(`- Relationship: ${rel.relationshipType}`);
          }
          if (rel.lastContactedAt) {
            lines.push(`- Last contacted: ${rel.lastContactedAt}`);
          }
          if (rel.notes && typeof rel.notes === "string" && rel.notes.trim()) {
            lines.push(`- Notes: ${rel.notes.trim()}`);
          }
          if (Array.isArray(rel.tags) && rel.tags.length > 0) {
            lines.push(`- Tags: ${rel.tags.join(", ")}`);
          }

          let interactions: any[] = [];
          if (typeof (this as any).getInteractions === "function") {
            try {
              interactions =
                (await (this as any).getInteractions(rel.id, {
                  limit: MAX_INTERACTIONS_PER_ATTENDEE,
                })) ?? [];
            } catch {
              interactions = [];
            }
          }
          if (interactions.length > 0) {
            lines.push(`- Recent interactions:`);
            for (const ix of interactions) {
              const when = ix.occurredAt ?? ix.createdAt ?? "?";
              const dir = ix.direction ?? "?";
              const ch = ix.channel ?? "?";
              const summary = (ix.summary ?? "").toString().trim();
              lines.push(`  - [${when}] (${ch}/${dir}) ${summary}`);
            }
          }

          attendeeBlocks.push(lines.join("\n"));
          sources.push({
            kind: "relationship",
            ref: rel.id,
            snippet: rel.name ?? handle,
          });
        }
      } else {
        for (const handle of handles) {
          sources.push({
            kind: "attendee",
            ref: handle,
            snippet: "(relationships mixin unavailable)",
          });
        }
      }

      if (attendeeBlocks.length > 0) {
        contextSections.push(`# Attendees\n${attendeeBlocks.join("\n\n")}`);
      }

      // 3. Extra context
      if (input.extraContextMd && input.extraContextMd.trim()) {
        const extra = input.extraContextMd.trim();
        contextSections.push(`# Additional Context\n${extra}`);
        sources.push({
          kind: "extra_context",
          ref: "inline",
          snippet: extra.slice(0, 200),
        });
      }

      const contextBlock = contextSections.join("\n\n");

      // 4. LLM briefing
      const prompt = [
        "You are drafting a concise pre-meeting briefing dossier for the",
        "user. Produce a clear markdown briefing under",
        `${MAX_BRIEFING_WORDS} words. Sections should include: Summary,`,
        "Who's Attending, Recent Context, Suggested Talking Points, and",
        "Open Questions. Use only the context provided — do not invent facts.",
        "",
        "=== CONTEXT ===",
        contextBlock,
        "=== END CONTEXT ===",
        "",
        "Return only the markdown briefing.",
      ].join("\n");

      const llmResult = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });
      const contentMd =
        typeof llmResult === "string"
          ? llmResult.trim()
          : String(llmResult ?? "").trim();

      const dossier: LifeOpsDossier = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        calendarEventId: input.calendarEventId ?? null,
        subject: input.subject,
        generatedForAt,
        contentMd,
        sources,
        metadata: {
          attendeeHandles: handles,
          hadCalendarEvent: Boolean(calendarEvent),
        },
        createdAt: now,
        updatedAt: now,
      };

      await this.repository.upsertDossier(dossier);
      return dossier;
    }

    async getDossier(id: string): Promise<LifeOpsDossier | null> {
      return this.repository.getDossier(this.agentId(), id);
    }

    async getDossierByEvent(
      calendarEventId: string,
    ): Promise<LifeOpsDossier | null> {
      return this.repository.getDossierByCalendarEvent(
        this.agentId(),
        calendarEventId,
      );
    }

    async listRecentDossiers(opts?: {
      limit?: number;
    }): Promise<LifeOpsDossier[]> {
      return this.repository.listDossiers(this.agentId(), opts);
    }
  }

  return LifeOpsDossierServiceMixin;
}

function summarizeCalendarEvent(event: any): string {
  if (!event || typeof event !== "object") return "";
  const parts: string[] = [];
  if (event.title) parts.push(`Title: ${event.title}`);
  if (event.start) parts.push(`Start: ${event.start}`);
  if (event.end) parts.push(`End: ${event.end}`);
  if (event.location) parts.push(`Location: ${event.location}`);
  if (Array.isArray(event.attendees) && event.attendees.length > 0) {
    const names = event.attendees
      .map((a: any) => a?.email ?? a?.name ?? a?.handle)
      .filter(Boolean);
    if (names.length > 0) parts.push(`Attendees: ${names.join(", ")}`);
  }
  if (event.description) {
    const desc = String(event.description).trim();
    if (desc) parts.push(`Description: ${desc.slice(0, 500)}`);
  }
  return parts.join("\n");
}
