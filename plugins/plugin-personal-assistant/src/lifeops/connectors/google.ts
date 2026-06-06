/**
 * Google connector contribution.
 *
 * Wraps {@link import("../service-mixin-google.js").LifeOpsGoogleService}
 * (Gmail + Calendar + Drive grants). Gmail's outbound `send` is gated by
 * `requiresApproval: true`; the runtime's owner-send-policy enqueues the
 * approval ScheduledTask before this connector ever sees the dispatch.
 *
 * Capabilities are namespaced — the entries here mirror
 * `LIFEOPS_GOOGLE_CAPABILITIES` from `@elizaos/shared`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { INTERNAL_URL } from "../access.js";
import { LifeOpsService } from "../service.js";
import {
  errorToDispatchResult,
  isConnectorSendPayload,
  legacyStatusToConnectorStatus,
  rejectInvalidPayload,
} from "./_helpers.js";
import type {
  ConnectorContribution,
  ConnectorStatus,
  DispatchResult,
} from "./contract.js";

export interface GoogleSendPayload {
  /** Comma-separated or array of recipients. */
  target: string;
  /** Plain-text body. */
  message: string;
  /** Optional structured metadata (subject, htmlBody, threadId, …). */
  metadata?: {
    subject?: string;
    side?: "owner" | "agent";
    htmlBody?: string;
  };
}

export function createGoogleConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "google",
    capabilities: [
      "google.basic_identity",
      "google.calendar.read",
      "google.calendar.write",
      "google.gmail.triage",
      "google.gmail.send",
      "google.gmail.manage",
    ],
    modes: ["local"],
    describe: { label: "Google (Gmail + Calendar)" },
    // Gmail outbound goes through the owner-send-policy approval queue.
    // `requiresApproval` is the registry-driven flag for this gate.
    requiresApproval: true,
    async start() {
      // No-op: connect is initiated through the dashboard OAuth UI; the
      // ConnectorContribution.start hook is reserved for connectors that
      // need eager session restoration.
    },
    async disconnect() {
      await service.disconnectGoogleConnector(
        { side: "owner", mode: "local" },
        INTERNAL_URL,
      );
    },
    async verify(): Promise<boolean> {
      const status = await service.getGoogleConnectorStatus(INTERNAL_URL);
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getGoogleConnectorStatus(INTERNAL_URL);
        return legacyStatusToConnectorStatus(status);
      } catch (error) {
        return {
          state: "disconnected",
          message: error instanceof Error ? error.message : String(error),
          observedAt: new Date().toISOString(),
        };
      }
    },
    async send(payload: unknown): Promise<DispatchResult> {
      if (!isConnectorSendPayload(payload)) return rejectInvalidPayload();
      const meta = (payload as GoogleSendPayload).metadata ?? {};
      try {
        const result = await service.sendGmailMessage(INTERNAL_URL, {
          mode: "local",
          side: meta.side ?? "owner",
          to: payload.target
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          subject: meta.subject ?? "(no subject)",
          bodyText: payload.message,
          confirmSend: true,
        });
        if (result.ok) {
          return { ok: true };
        }
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          message: "Gmail send returned a non-ok response.",
        };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
  };
}
