/**
 * The Network takeover (docs/design/eliza-conversation-layer.md in the thenetwork repo): when
 * NETWORK_TAKEOVER=1, every direct Network message is first handed to the Network service's
 * deterministic loop (`POST /internal/turn`). A handled turn is answered with the service's
 * replies and no model call; an open turn continues to the shared agent with the service's
 * member context. Groups keep the gateway's own keyword handling.
 *
 * The service owns STOP/START/leave; the gateway mirrors the resulting consent into its ledger
 * so the send-time fence (mid-turn STOP, /internal/deliver) stays correct.
 */
import { NetworkServiceClient } from "@thenetwork/plugin-network/client";
import type { NetworkAppId, TurnContext, TurnRequest, TurnResponse } from "@thenetwork/plugin-network/contract";
import type { ChatEvent } from "./adapters/types";
import type { NetworkConsentLedger } from "./network-compliance";

export interface NetworkOpenTurn {
  app: NetworkAppId;
  memberId: string;
  messageId: string;
  context: TurnContext;
}

export type NetworkServiceTurn =
  | { kind: "reply"; texts: string[]; reason: string }
  | { kind: "open"; turn: NetworkOpenTurn }
  | { kind: "continue"; reason: string };

/** The service client when the takeover is on and configured; undefined otherwise (legacy path). */
export function networkServiceFromEnv(
  env: Record<string, string | undefined> = process.env,
): NetworkServiceClient | undefined {
  if (env.NETWORK_TAKEOVER !== "1") return undefined;
  const baseUrl = env.NETWORK_SERVICE_URL?.trim();
  const secret = env.SERVICE_TURN_SECRET;
  if (!baseUrl || !secret) return undefined;
  return new NetworkServiceClient({ baseUrl, secret });
}

/**
 * Staged rollout: NETWORK_TAKEOVER_ALLOWLIST (comma-separated E.164 numbers).
 * When set, only these senders take the service path; everyone else keeps the
 * legacy path. Unset = every sender (full takeover).
 */
export function takeoverAppliesTo(
  sender: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.NETWORK_TAKEOVER_ALLOWLIST?.trim();
  if (!raw) return true;
  const allowed = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return allowed.has(sender.trim());
}

const TRANSPORTS = new Set(["imessage", "sms", "rcs"]);

export function turnRequestFor(event: ChatEvent): TurnRequest {
  const protocol = event.protocol?.toLowerCase();
  return {
    messageId: event.messageId,
    channel: event.platform === "twilio" ? "twilio" : "blooio",
    from: event.senderId,
    to: event.channelId ?? null,
    text: event.text,
    transport: protocol && TRANSPORTS.has(protocol) ? (protocol as TurnRequest["transport"]) : "unknown",
    receivedAt: event.providerSentAtMs ?? Date.now(),
  };
}

/** Runs one direct Network message through the service. Throws on a service failure (the caller reopens the webhook; the turn is idempotent). */
export async function runNetworkServiceTurn(
  client: Pick<NetworkServiceClient, "turn">,
  ledger: NetworkConsentLedger,
  project: string,
  event: ChatEvent,
  now: () => Date = () => new Date(),
): Promise<NetworkServiceTurn> {
  const res: TurnResponse = await client.turn(turnRequestFor(event));
  if (res.outcome === "handled") {
    // Line-wide consent changes only: an app-scoped leave does not stop the shared line.
    if (res.consent?.scope === "all") {
      await ledger.record({
        project,
        channel: event.platform,
        address: event.senderId,
        state: res.consent.state,
        source: `service:${res.reason}`,
        providerMessageId: event.messageId,
        at: now().toISOString(),
      });
    }
    return { kind: "reply", texts: res.replies.filter((t) => t.trim().length > 0), reason: res.reason };
  }
  if (res.outcome === "open") {
    return { kind: "open", turn: { app: res.app, memberId: res.memberId, messageId: event.messageId, context: res.context } };
  }
  return { kind: "continue", reason: res.reason };
}
