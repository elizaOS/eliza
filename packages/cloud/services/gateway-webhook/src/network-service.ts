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
import { NetworkServiceClient } from "@elizaos/plugin-network/client";
import type {
  NetworkAppId,
  TurnContext,
  TurnRequest,
  TurnResponse,
} from "@elizaos/plugin-network/contract";
import type { ChatEvent } from "./adapters/types";
import type { NetworkConsentLedger } from "./network-compliance";

/** Canonical Shared admission policy parsing and scope matching, preserved from its EA owner. */
export interface NetworkIngressScope {
  project: string;
  platform: "blooio" | "twilio";
  connectorAccountId: string;
  phoneNumber: string;
  messageId: string;
  message: string;
}
export interface NetworkAdmissionPolicy {
  phoneNumber: string;
  project: "eliza-app";
  platform: "blooio" | "twilio";
  connectorAccountId: string;
  messageIdPrefix: string;
  userId: string;
  organizationId: string;
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export function parseNetworkAdmissionPolicy(
  raw: string | undefined,
): NetworkAdmissionPolicy | undefined {
  if (!raw || raw.length > 2048) return undefined;
  try {
    const p = JSON.parse(raw) as NetworkAdmissionPolicy;
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).sort().join() !==
        [
          "phoneNumber",
          "project",
          "platform",
          "connectorAccountId",
          "messageIdPrefix",
          "userId",
          "organizationId",
        ]
          .sort()
          .join() ||
      p.project !== "eliza-app" ||
      typeof p.phoneNumber !== "string" ||
      !/^\+[1-9]\d{6,14}$/u.test(p.phoneNumber) ||
      p.messageIdPrefix !== `${p.platform}:${p.project}:` ||
      !["blooio", "twilio"].includes(p.platform) ||
      typeof p.connectorAccountId !== "string" ||
      !p.connectorAccountId.trim() ||
      p.connectorAccountId.length > 160 ||
      typeof p.messageIdPrefix !== "string" ||
      !p.messageIdPrefix ||
      p.messageIdPrefix.length > 80 ||
      typeof p.userId !== "string" ||
      typeof p.organizationId !== "string" ||
      !UUID.test(p.userId) ||
      !UUID.test(p.organizationId)
    )
      return undefined;
    return p;
  } catch {
    // error-policy:J3 Malformed untrusted policy is invalid; no authority is fabricated.
    return undefined;
  }
}
/** Invoked before any account resolution; a signature is still required separately. */
export function networkIngressMatchesPolicy(
  ingress: NetworkIngressScope,
  policy: NetworkAdmissionPolicy | undefined,
  enabled: string | undefined,
): boolean {
  return (
    enabled === "true" &&
    !!policy &&
    ingress.project === policy.project &&
    ingress.platform === policy.platform &&
    ingress.connectorAccountId === policy.connectorAccountId &&
    ingress.phoneNumber === policy.phoneNumber &&
    ingress.messageId.startsWith(policy.messageIdPrefix) &&
    ingress.messageId.length > policy.messageIdPrefix.length &&
    /^\+[1-9]\d{6,14}$/u.test(ingress.phoneNumber) &&
    !!ingress.message.trim()
  );
}

export interface NetworkOpenTurn {
  channel: TurnRequest["channel"];
  app: NetworkAppId;
  memberId: string;
  messageId: string;
  context: TurnContext;
}

export type NetworkServiceTurn =
  | {
      kind: "reply";
      texts: string[];
      reason: string;
      request: TurnRequest;
      handled: Extract<TurnResponse, { outcome: "handled" }>;
    }
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

const TRANSPORTS = new Set(["imessage", "sms", "rcs"]);

export function turnRequestFor(event: ChatEvent): TurnRequest {
  const protocol = event.protocol?.toLowerCase();
  const receivedAt = event.gatewayReceivedAtMs ?? event.providerSentAtMs;
  if (!Number.isSafeInteger(receivedAt) || !receivedAt || receivedAt <= 0)
    throw new Error("Network turn requires a durable ingress timestamp");
  return {
    messageId: event.messageId,
    channel: event.platform === "twilio" ? "twilio" : "blooio",
    from: event.senderId,
    to: event.receivingNumber ?? event.channelId ?? null,
    text: event.text,
    transport:
      protocol && TRANSPORTS.has(protocol)
        ? (protocol as TurnRequest["transport"])
        : "unknown",
    receivedAt,
  };
}

/** Runs one direct Network message through the service. Throws on a service failure (the caller reopens the webhook; the turn is idempotent). */
export async function runNetworkServiceTurn(
  client: Pick<NetworkServiceClient, "turn">,
  ledger: NetworkConsentLedger,
  project: string,
  event: ChatEvent,
): Promise<NetworkServiceTurn> {
  const request = turnRequestFor(event);
  const res: TurnResponse = await client.turn(request);
  if (res.outcome === "handled") {
    // Line-wide consent changes only: an app-scoped leave does not stop the shared line.
    if (res.consent) {
      if (
        (res.consent.scope !== "all" && res.consent.scope !== "app") ||
        (res.consent.state !== "opted_in" &&
          res.consent.state !== "opted_out") ||
        !Number.isSafeInteger(res.consent.at) ||
        res.consent.at <= 0 ||
        (res.consent.scope === "all" &&
          (res.consent.app !== null || res.consent.state !== "opted_out")) ||
        (res.consent.scope === "app" &&
          !["ntwrk", "slop", "peon", "friends"].includes(
            String(res.consent.app),
          ))
      )
        throw new Error("Invalid canonical service consent");
      await ledger.record({
        project,
        app: res.consent.scope === "app" ? res.consent.app : null,
        channel: event.platform,
        address: event.senderId,
        state: res.consent.state,
        source: `service:${res.reason}`,
        providerMessageId: event.messageId,
        at: new Date(res.consent.at).toISOString(),
      });
    }
    return {
      kind: "reply",
      texts: res.replies,
      reason: res.reason,
      request,
      handled: res,
    };
  }
  if (res.outcome === "open") {
    return {
      kind: "open",
      turn: {
        channel: res.channel,
        app: res.app,
        memberId: res.memberId,
        messageId: event.messageId,
        context: res.context,
      },
    };
  }
  return { kind: "continue", reason: res.reason };
}
