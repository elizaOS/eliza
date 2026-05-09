/**
 * W2-B — Calendly connector contribution.
 *
 * Calendly is a scheduling-link provider — there is no outbound `send`. The
 * `read` verb lists scheduled events. The full Calendly API client is owned
 * by `@elizaos/plugin-calendly` and re-exported through `../calendly-client.ts`.
 *
 * **W2-B vs W2-C ownership split:** W2-B (this file) owns the connector
 * wrapper that registers Calendly with `ConnectorRegistry`. W2-C owns the
 * action-level extraction of `calendly_*` subactions from CALENDAR.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  listCalendlyScheduledEvents,
  readCalendlyCredentialsFromEnv,
} from "../calendly-client.js";
import type {
  ConnectorContribution,
  ConnectorStatus,
  DispatchResult,
} from "./contract.js";

export function createCalendlyConnectorContribution(
  _runtime: IAgentRuntime,
): ConnectorContribution {
  return {
    kind: "calendly",
    capabilities: [
      "calendly.events.read",
      "calendly.event_types.read",
      "calendly.availability.read",
      "calendly.single_use_link.create",
    ],
    modes: ["cloud"],
    describe: { label: "Calendly" },
    async start() {},
    async disconnect() {
      // Calendly OAuth lifecycle is owned by @elizaos/plugin-calendly.
    },
    async verify(): Promise<boolean> {
      return readCalendlyCredentialsFromEnv() != null;
    },
    async status(): Promise<ConnectorStatus> {
      const credentials = readCalendlyCredentialsFromEnv();
      const observedAt = new Date().toISOString();
      if (!credentials) {
        return {
          state: "disconnected",
          message:
            "Calendly is not configured. Connect Calendly via @elizaos/plugin-calendly to expose scheduled-event reads.",
          observedAt,
        };
      }
      return { state: "ok", observedAt };
    },
    // Calendly has no outbound `send`. The DispatchResult below documents
    // the explicit refusal so the runner's dispatch policy can surface it
    // cleanly rather than silently no-op'ing.
    async send(): Promise<DispatchResult> {
      return {
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message:
          "Calendly does not support outbound send. Use createCalendlySingleUseLink to share a scheduling link.",
      };
    },
    async read(query: unknown) {
      const credentials = readCalendlyCredentialsFromEnv();
      if (!credentials) return [];
      const params = (query ?? {}) as {
        minStartTime?: string;
        limit?: number;
        status?: "active" | "canceled";
      };
      return listCalendlyScheduledEvents(credentials, {
        minStartTime: params.minStartTime,
        limit: params.limit ?? 50,
        status: params.status ?? "active",
      });
    },
  };
}
