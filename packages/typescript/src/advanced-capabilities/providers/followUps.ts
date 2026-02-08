import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type { FollowUpService } from "../../services/followUp.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("FOLLOW_UPS");

export const followUpsProvider: Provider = {
  name: spec.name,
  description: spec.description,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const followUpService = runtime.getService("follow_up") as FollowUpService;
    if (!followUpService) {
      runtime.logger.warn("[FollowUpsProvider] FollowUpService not available");
      return { text: "", values: {}, data: {} };
    }

    // Get upcoming follow-ups for the next 7 days
    const upcomingFollowUps = await followUpService.getUpcomingFollowUps(
      7,
      true,
    );

    if (upcomingFollowUps.length === 0) {
      return {
        text: "No upcoming follow-ups scheduled.",
        values: { followUpCount: 0 },
        data: {},
      };
    }

    const now = Date.now();
    const contactIds = Array.from(
      new Set(upcomingFollowUps.map((f) => f.contact.entityId)),
    );
    const entities = await Promise.all(
      contactIds.map((id) => runtime.getEntityById(id)),
    );
    const entityNames = new Map<string, string>();
    for (let i = 0; i < contactIds.length; i += 1) {
      entityNames.set(contactIds[i], entities[i]?.names[0] || "Unknown");
    }

    const overdue: typeof upcomingFollowUps = [];
    const upcoming: typeof upcomingFollowUps = [];
    const scheduledAtMs = new Map<string, number>();
    for (const item of upcomingFollowUps) {
      const scheduledAt = item.task.metadata?.scheduledAt
        ? new Date(item.task.metadata.scheduledAt as string).getTime()
        : 0;
      if (item.task.id) {
        scheduledAtMs.set(item.task.id, scheduledAt);
      }
      if (scheduledAt < now) {
        overdue.push(item);
      } else {
        upcoming.push(item);
      }
    }

    // Build text summary
    let textSummary = `You have ${upcomingFollowUps.length} follow-up${upcomingFollowUps.length !== 1 ? "s" : ""} scheduled:\n`;

    if (overdue.length > 0) {
      textSummary += `\nOverdue (${overdue.length}):\n`;
      for (const f of overdue) {
        const name = entityNames.get(f.contact.entityId) || "Unknown";
        const scheduledAt = f.task.id ? (scheduledAtMs.get(f.task.id) ?? 0) : 0;

        textSummary += `- ${name}`;
        if (scheduledAt > 0) {
          const daysOverdue = Math.floor(
            (now - scheduledAt) / (1000 * 60 * 60 * 24),
          );
          textSummary += ` (${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue)`;
        }
        if (f.task.metadata?.reason) {
          textSummary += ` - ${f.task.metadata.reason}`;
        }
        textSummary += "\n";
      }
    }

    if (upcoming.length > 0) {
      textSummary += `\nUpcoming (${upcoming.length}):\n`;
      for (const f of upcoming) {
        const name = entityNames.get(f.contact.entityId) || "Unknown";
        const scheduledAt = f.task.id ? (scheduledAtMs.get(f.task.id) ?? 0) : 0;

        textSummary += `- ${name}`;
        if (scheduledAt > 0) {
          const daysUntil = Math.ceil(
            (scheduledAt - now) / (1000 * 60 * 60 * 24),
          );
          if (daysUntil === 0) {
            textSummary += " (today)";
          } else if (daysUntil === 1) {
            textSummary += " (tomorrow)";
          } else {
            textSummary += ` (in ${daysUntil} days)`;
          }
        }
        if (f.task.metadata?.reason) {
          textSummary += ` - ${f.task.metadata.reason}`;
        }
        textSummary += "\n";
      }
    }

    // Get follow-up suggestions
    const suggestions = await followUpService.getFollowUpSuggestions();

    if (suggestions.length > 0) {
      textSummary += `\nSuggested follow-ups:\n`;
      suggestions.slice(0, 3).forEach((s) => {
        textSummary += `- ${s.entityName} (${s.daysSinceLastContact} days since last contact)\n`;
      });
    }

    return {
      text: textSummary.trim(),
      values: {
        followUpCount: upcomingFollowUps.length,
        overdueCount: overdue.length,
        upcomingCount: upcoming.length,
        suggestionsCount: suggestions.length,
      },
      data: {
        followUpCount: upcomingFollowUps.length,
        overdueCount: overdue.length,
        upcomingCount: upcoming.length,
        suggestionsCount: suggestions.length,
      },
    };
  },
};
