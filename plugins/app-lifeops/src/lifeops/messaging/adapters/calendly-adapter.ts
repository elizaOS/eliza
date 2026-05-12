import type {
  IAgentRuntime,
  ListOptions,
  MessageAdapterCapabilities,
  MessageRef,
  MessageSource,
} from "@elizaos/core";
import { BaseMessageAdapter } from "@elizaos/core";
import {
  type CalendlyScheduledEvent,
  listCalendlyScheduledEvents,
  readCalendlyCredentialsFromEnv,
} from "../../calendly-client.js";
import { listCalendlyScheduledEventsWithRuntimeService } from "../../runtime-service-delegates.js";

function eventToMessageRef(event: CalendlyScheduledEvent): MessageRef {
  const startMs = Date.parse(event.startTime);
  const inviteeNames = event.invitees
    .map((inv) => inv.name ?? inv.email ?? "")
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

export class CalendlyAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "calendly";

  isAvailable(runtime: IAgentRuntime): boolean {
    const service = runtime.getService?.("calendly") as
      | { isConnected?: (accountId?: string) => boolean }
      | null
      | undefined;
    const serviceAvailable =
      service && typeof service === "object"
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
    const delegated = await listCalendlyScheduledEventsWithRuntimeService({
      runtime,
      options: {
        minStartTime,
        limit: opts.limit ?? 50,
        status: "active",
      },
    });
    if (delegated.status === "handled") {
      return delegated.value.map(eventToMessageRef);
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
