/**
 * @module CalendlyService
 * @description Service that owns Calendly API access and exposes a domain-shaped
 * surface to actions. Wraps calendly-client.ts and supports N accounts via the
 * standard accounts.ts pattern.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  type CalendlyAccountConfig,
  readCalendlyAccounts,
  resolveCalendlyAccountId,
} from "../accounts.js";
import {
  cancelCalendlyScheduledEvent,
  type CalendlyAvailabilityNormalized,
  type CalendlyCredentials,
  CalendlyError,
  type CalendlyEventTypeNormalized,
  type CalendlyScheduledEventNormalized,
  type CalendlySingleUseLink,
  createCalendlySingleUseLink,
  getCalendlyUser,
  listCalendlyEventTypes,
  listCalendlyScheduledEvents,
  getCalendlyAvailability as fetchCalendlyAvailability,
} from "../calendly-client.js";
import type {
  BookingLinkQuery,
  CalendlyAvailability,
  CalendlyEventType,
  CalendlyScheduledEvent,
} from "../types.js";

export const CALENDLY_SERVICE_TYPE = "calendly";

interface CalendlyClientEntry {
  config: CalendlyAccountConfig;
  credentials: CalendlyCredentials;
  cachedUserUri?: string;
}

function toEventType(
  normalized: CalendlyEventTypeNormalized,
): CalendlyEventType {
  return {
    uri: normalized.uri,
    name: normalized.name,
    active: normalized.active,
    slug: normalized.slug,
    scheduling_url: normalized.schedulingUrl,
    duration: normalized.durationMinutes,
    kind: "solo",
    type: "StandardEventType",
    description_plain: null,
  };
}

function toScheduledEvent(
  normalized: CalendlyScheduledEventNormalized,
): CalendlyScheduledEvent {
  return {
    uri: normalized.uri,
    name: normalized.name,
    startTime: normalized.startTime,
    endTime: normalized.endTime,
    status: normalized.status,
    invitees: normalized.invitees,
  };
}

function toAvailability(
  normalized: CalendlyAvailabilityNormalized,
): CalendlyAvailability {
  return {
    date: normalized.date,
    slots: normalized.slots,
  };
}

export class CalendlyService extends Service {
  static override serviceType = CALENDLY_SERVICE_TYPE;
  capabilityDescription =
    "Connects the agent to Calendly v2 for event types, scheduled events, availability, and booking-link handoff.";

  private clientsByAccountId = new Map<string, CalendlyClientEntry>();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static override async start(runtime: IAgentRuntime): Promise<CalendlyService> {
    const service = new CalendlyService(runtime);
    service.initialize();
    return service;
  }

  private initialize(): void {
    if (!this.runtime) return;
    const accounts = readCalendlyAccounts(this.runtime);
    if (accounts.length === 0) {
      logger.info(
        { src: "plugin:calendly" },
        "Calendly access token not configured -- service inactive",
      );
      return;
    }
    for (const account of accounts) {
      this.clientsByAccountId.set(account.accountId, {
        config: account,
        credentials: { personalAccessToken: account.accessToken },
      });
    }
    logger.info(
      {
        src: "plugin:calendly",
        accountCount: this.clientsByAccountId.size,
      },
      `Calendly service initialized with ${this.clientsByAccountId.size} account(s)`,
    );
  }

  /**
   * Test hook. Bypasses env-var resolution and registers a single account.
   */
  attach(options: {
    accountId?: string;
    credentials: CalendlyCredentials;
    cachedUserUri?: string;
  }): void {
    const accountId = options.accountId ?? "default";
    this.clientsByAccountId.set(accountId, {
      config: {
        accountId,
        accessToken: options.credentials.personalAccessToken,
      },
      credentials: options.credentials,
      cachedUserUri: options.cachedUserUri,
    });
  }

  isConnected(accountId?: string): boolean {
    const id =
      accountId ??
      (this.runtime ? resolveCalendlyAccountId(this.runtime) : undefined);
    if (!id) return this.clientsByAccountId.size > 0;
    return this.clientsByAccountId.has(id);
  }

  private requireEntry(accountId?: string): CalendlyClientEntry {
    const id =
      accountId ??
      (this.runtime ? resolveCalendlyAccountId(this.runtime) : undefined);
    if (id) {
      const entry = this.clientsByAccountId.get(id);
      if (entry) return entry;
    }
    const first = this.clientsByAccountId.values().next().value;
    if (first) return first;
    throw new CalendlyError(
      "Calendly is not connected -- configure CALENDLY_ACCESS_TOKEN.",
      0,
    );
  }

  async listEventTypes(accountId?: string): Promise<CalendlyEventType[]> {
    const entry = this.requireEntry(accountId);
    const normalized = await listCalendlyEventTypes(entry.credentials);
    return normalized.map(toEventType);
  }

  async listScheduledEvents(
    options?: Record<string, unknown>,
    accountId?: string,
  ): Promise<CalendlyScheduledEvent[]> {
    const entry = this.requireEntry(accountId);
    const minStartTime =
      typeof options?.minStartTime === "string"
        ? options.minStartTime
        : undefined;
    const maxStartTime =
      typeof options?.maxStartTime === "string"
        ? options.maxStartTime
        : undefined;
    const status =
      options?.status === "active" || options?.status === "canceled"
        ? options.status
        : undefined;
    const limit =
      typeof options?.limit === "number" ? options.limit : undefined;
    const normalized = await listCalendlyScheduledEvents(entry.credentials, {
      minStartTime,
      maxStartTime,
      status,
      limit,
    });
    return normalized.map(toScheduledEvent);
  }

  async getAvailability(
    eventTypeUri: string,
    options: { startDate: string; endDate: string; timezone?: string },
    accountId?: string,
  ): Promise<CalendlyAvailability[]> {
    const entry = this.requireEntry(accountId);
    const normalized = await fetchCalendlyAvailability(
      entry.credentials,
      eventTypeUri,
      options,
    );
    return normalized.map(toAvailability);
  }

  async createSingleUseLink(
    eventTypeUri: string,
    accountId?: string,
  ): Promise<CalendlySingleUseLink> {
    const entry = this.requireEntry(accountId);
    return createCalendlySingleUseLink(entry.credentials, eventTypeUri);
  }

  async getBookingUrl(
    query?: BookingLinkQuery,
    accountId?: string,
  ): Promise<string | null> {
    const entry = this.requireEntry(accountId);
    const eventTypes = await listCalendlyEventTypes(entry.credentials);
    const active = eventTypes.filter((et) => et.active);
    if (active.length === 0) return null;

    if (query?.slug) {
      const match = active.find((et) => et.slug === query.slug);
      if (match) return match.schedulingUrl;
    }
    if (typeof query?.durationMinutes === "number") {
      const match = active.find(
        (et) => et.durationMinutes === query.durationMinutes,
      );
      if (match) return match.schedulingUrl;
    }
    return active[0]?.schedulingUrl ?? null;
  }

  async cancelBooking(
    uuid: string,
    reason?: string,
    accountId?: string,
  ): Promise<void> {
    const entry = this.requireEntry(accountId);
    await cancelCalendlyScheduledEvent(entry.credentials, uuid, reason);
  }

  async getCachedUserUri(accountId?: string): Promise<string | undefined> {
    const entry = this.requireEntry(accountId);
    if (entry.cachedUserUri) return entry.cachedUserUri;
    try {
      const user = await getCalendlyUser(entry.credentials);
      entry.cachedUserUri = user.uri;
      return user.uri;
    } catch {
      return undefined;
    }
  }

  async stop(): Promise<void> {
    this.clientsByAccountId.clear();
  }
}

export default CalendlyService;
