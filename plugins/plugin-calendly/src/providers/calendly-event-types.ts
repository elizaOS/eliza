/**
 * @module providers/calendly-event-types
 * @description calendlyEventTypes — read-only provider that surfaces the
 * connected Calendly user's active event types as JSON context.
 *
 * This is a provider rather than an action because enumerating the user's own
 * event types is read-only context for planning a booking, not a side-effecting
 * agent operation.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { resolveCalendlyAccountId } from "../accounts.js";
import type { CalendlyService } from "../services/CalendlyService.js";
import { CALENDLY_SERVICE_TYPE } from "../types.js";

interface CalendlyEventTypeEntry {
  uri: string;
  name: string;
  slug: string;
  durationMinutes: number;
  schedulingUrl: string;
  active: boolean;
  kind: string;
  type: string;
}

const MAX_EVENT_TYPES = 20;

export const calendlyEventTypesProvider: Provider = {
  name: "calendlyEventTypes",
  description:
    "Lists the connected Calendly user's active event types with scheduling URLs and durations.",
  descriptionCompressed:
    "Calendly event types (name, slug, duration, scheduling URL).",
  dynamic: true,
  contexts: ["connectors", "productivity"],
  contextGate: { anyOf: ["connectors", "productivity"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<CalendlyService>(CALENDLY_SERVICE_TYPE);
    const accountId = resolveCalendlyAccountId(runtime);
    if (!service?.isConnected(accountId)) {
      return { data: {}, values: { calendlyConnected: false }, text: "" };
    }

    let eventTypes: Awaited<ReturnType<CalendlyService["listEventTypes"]>>;
    try {
      eventTypes = await service.listEventTypes(accountId);
    } catch (err) {
      // error-policy:J4 explicit degrade — a Calendly API/auth/network failure
      // renders a distinguishable error line (empty text here was
      // indistinguishable from the designed not-connected state, so the
      // planner read a broken Calendly read as "nothing to show"), and
      // reportError surfaces the failure to RECENT_ERRORS / owner-escalation.
      runtime.reportError?.("calendlyEventTypes.provider", err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        data: { calendlyConnected: true, error: message },
        values: { calendlyConnected: true, calendlyError: message },
        text: "Error retrieving Calendly event types",
      };
    }
    const entries: CalendlyEventTypeEntry[] = eventTypes
      .filter((et) => et.active)
      .slice(0, MAX_EVENT_TYPES)
      .map((et) => ({
        uri: et.uri,
        name: et.name,
        slug: et.slug,
        durationMinutes: et.duration,
        schedulingUrl: et.scheduling_url,
        active: et.active,
        kind: et.kind,
        type: et.type,
      }));

    return {
      data: {
        calendlyConnected: true,
        eventTypeCount: entries.length,
        eventTypes: entries,
      },
      values: {
        calendlyConnected: true,
        eventTypeCount: entries.length,
      },
      text: JSON.stringify({
        calendly_event_types: {
          count: entries.length,
          items: entries,
        },
      }),
    };
  },
};

export default calendlyEventTypesProvider;
