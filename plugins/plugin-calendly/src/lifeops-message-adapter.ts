/**
 * Projects Calendly scheduled events into the core `MessageRef` triage shape so
 * assistant/LifeOps surfaces can list them alongside other message sources.
 * Prefers the running CalendlyService when connected and falls back to
 * env-configured credentials via the raw client.
 */

import {
  BaseMessageAdapter,
  type IAgentRuntime,
  type ListOptions,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
} from "@elizaos/core/node";
import {
  listCalendlyScheduledEvents,
  readCalendlyCredentialsFromEnv,
} from "./calendly-client.js";
import type { CalendlyScheduledEvent } from "./types.js";

function eventToMessageRef(event: CalendlyScheduledEvent): MessageRef {
  const startMs = Date.parse(event.startTime);
  const inviteeNames = event.invitees
    .map((invitee) => invitee.name ?? invitee.email ?? "")
    .filter(Boolean);
  const senderId = event.invitees[0]?.email ?? event.uri;
  const senderName = event.invitees[0]?.name ?? inviteeNames.join(", ");
  return {
    id: `calendly:${event.uri}`,
    source: "calendly",
    externalId: event.uri,
    threadId: event.uri,
    from: { identifier: senderId, displayName: senderName },
    to: [],
    subject: event.name,
    snippet: `${event.name} on ${event.startTime}`,
    body: `${event.name}\nstart: ${event.startTime}\nend: ${event.endTime}\nstatus: ${event.status}\ninvitees: ${inviteeNames.join(", ")}`,
    receivedAtMs: Number.isFinite(startMs) ? startMs : Date.now(),
    hasAttachments: false,
    isRead: true,
    channelId: event.uri,
    metadata: {
      status: event.status,
      endTime: event.endTime,
      invitees: event.invitees,
    },
  };
}

type CalendlyRuntimeServiceLike = {
  isConnected?: (accountId?: string) => boolean;
  listScheduledEvents?: (
    options?: Record<string, unknown>,
    accountId?: string,
  ) => Promise<CalendlyScheduledEvent[]>;
};

function getCalendlyRuntimeService(
  runtime: IAgentRuntime,
): CalendlyRuntimeServiceLike | null {
  const service = runtime.getService("calendly");
  return service && typeof service === "object"
    ? (service as CalendlyRuntimeServiceLike)
    : null;
}

export class CalendlyAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "calendly";

  isAvailable(runtime: IAgentRuntime): boolean {
    const service = getCalendlyRuntimeService(runtime);
    const serviceAvailable = service
      ? typeof service.isConnected === "function"
        ? service.isConnected("default")
        : true
      : false;
    return serviceAvailable || readCalendlyCredentialsFromEnv() != null;
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      list: true,
      search: false,
      manage: {},
      send: {},
      worlds: "single",
      channels: "explicit",
    };
  }

  protected async listMessagesImpl(
    runtime: IAgentRuntime,
    opts: ListOptions,
  ): Promise<MessageRef[]> {
    const minStartTime = opts.sinceMs
      ? new Date(opts.sinceMs).toISOString()
      : undefined;
    const service = getCalendlyRuntimeService(runtime);
    if (
      service &&
      (typeof service.isConnected !== "function" ||
        service.isConnected("default")) &&
      typeof service.listScheduledEvents === "function"
    ) {
      const events = await service.listScheduledEvents(
        {
          minStartTime,
          limit: opts.limit ?? 50,
          status: "active",
        },
        "default",
      );
      return events.map(eventToMessageRef);
    }

    const credentials = readCalendlyCredentialsFromEnv();
    if (!credentials) return [];
    const events = await listCalendlyScheduledEvents(credentials, {
      minStartTime,
      limit: opts.limit ?? 50,
      status: "active",
    });
    return events.map(eventToMessageRef);
  }

  protected async getMessageImpl(
    runtime: IAgentRuntime,
    id: string,
  ): Promise<MessageRef | null> {
    const all = await this.listMessages(runtime, { limit: 200 });
    return all.find((ref) => ref.id === id) ?? null;
  }
}
