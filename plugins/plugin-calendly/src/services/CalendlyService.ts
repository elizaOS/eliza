/**
 * @module CalendlyService
 * @description Service that owns the CalendlyClient and exposes a narrow
 * domain-shaped surface to actions.
 *
 * Responsibilities:
 *  - Resolve the access token from `CALENDLY_ACCESS_TOKEN` (production) or
 *    `MILADY_E2E_CALENDLY_ACCESS_TOKEN` (E2E fallback).
 *  - Instantiate the REST client lazily and cache the authenticated user URI.
 *  - Provide typed accessors actions use instead of the raw client.
 *
 * The service intentionally does not swallow client errors. Actions translate
 * them into `CalendlyActionResult` shapes near the boundary.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { CalendlyClient, type FetchLike } from "../calendly-client.js";
import {
  type BookingLinkQuery,
  CALENDLY_SERVICE_TYPE,
  type CalendlyEventType,
  type CalendlyInvitee,
  type CalendlyScheduledEvent,
  type CalendlyUser,
  type ICalendlyService,
} from "../types.js";

function readAccessToken(runtime: IAgentRuntime): string | undefined {
  const production = runtime.getSetting("CALENDLY_ACCESS_TOKEN");
  if (typeof production === "string" && production.length > 0) {
    return production;
  }
  const e2e = runtime.getSetting("MILADY_E2E_CALENDLY_ACCESS_TOKEN");
  if (typeof e2e === "string" && e2e.length > 0) {
    return e2e;
  }
  return undefined;
}

export class CalendlyService extends Service implements ICalendlyService {
  static serviceType = CALENDLY_SERVICE_TYPE;
  capabilityDescription =
    "Calendly v2 integration — event types, scheduled events, and cancellations";

  private client: CalendlyClient | null = null;
  private cachedUser: CalendlyUser | null = null;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CalendlyService(runtime);
    service.initialize();
    return service;
  }

  private initialize(): void {
    if (!this.runtime) {
      return;
    }
    const token = readAccessToken(this.runtime);
    if (!token) {
      logger.info(
        "[CalendlyService] CALENDLY_ACCESS_TOKEN not set — actions will report a graceful not-connected error",
      );
      return;
    }
    this.client = new CalendlyClient({ accessToken: token });
  }

  /**
   * Test hook. Bypasses env-var resolution and injects a pre-built client
   * plus an optional cached user so actions can be exercised without IO.
   */
  attach(options: {
    accessToken?: string;
    fetchImpl?: FetchLike;
    client?: CalendlyClient;
    cachedUser?: CalendlyUser | null;
  }): void {
    if (options.client) {
      this.client = options.client;
    } else if (options.accessToken) {
      this.client = new CalendlyClient({
        accessToken: options.accessToken,
        fetchImpl: options.fetchImpl,
      });
    }
    if (options.cachedUser !== undefined) {
      this.cachedUser = options.cachedUser;
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  private requireClient(): CalendlyClient {
    if (!this.client) {
      throw new Error(
        "Calendly is not connected — set CALENDLY_ACCESS_TOKEN to enable this action",
      );
    }
    return this.client;
  }

  private async getUser(): Promise<CalendlyUser> {
    if (this.cachedUser) {
      return this.cachedUser;
    }
    const user = await this.requireClient().getCurrentUser();
    this.cachedUser = user;
    return user;
  }

  async listEventTypes(): Promise<CalendlyEventType[]> {
    const user = await this.getUser();
    const response = await this.requireClient().listEventTypes(user.uri);
    return response.collection;
  }

  async getBookingUrl(query?: BookingLinkQuery): Promise<string | null> {
    const user = await this.getUser();
    const eventTypes = await this.listEventTypes();
    if (query?.slug) {
      const match = eventTypes.find((et) => et.slug === query.slug);
      if (match) {
        return match.scheduling_url;
      }
    }
    if (typeof query?.durationMinutes === "number") {
      const byDuration = eventTypes.find(
        (et) => et.duration === query.durationMinutes && et.active,
      );
      if (byDuration) {
        return byDuration.scheduling_url;
      }
    }
    const firstActive = eventTypes.find((et) => et.active);
    if (firstActive) {
      return firstActive.scheduling_url;
    }
    return user.scheduling_url;
  }

  async getScheduledEvent(uuid: string): Promise<CalendlyScheduledEvent> {
    return this.requireClient().getScheduledEvent(uuid);
  }

  async getInvitee(
    eventUuid: string,
    inviteeUuid: string,
  ): Promise<CalendlyInvitee> {
    return this.requireClient().getInvitee(eventUuid, inviteeUuid);
  }

  async cancelBooking(uuid: string, reason?: string): Promise<void> {
    await this.requireClient().cancelScheduledEvent(uuid, reason);
  }

  async stop(): Promise<void> {
    this.client = null;
    this.cachedUser = null;
  }
}
