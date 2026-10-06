/**
 * Proactive (agent-initiated) messages for The Network.
 *
 * Sends go through the gateway's `/internal/deliver` (Twilio or Blooio, Redis
 * idempotency, consent ledger enforced there). Once the provider has accepted
 * the message, it is appended to the member's Network Durable Object history
 * as an assistant turn, so when the member replies "yes" the agent knows what
 * it asked. An unknown or refused delivery is never written to history.
 *
 * If the history append fails after the provider accepted the send, retrying
 * with the same idempotency key is safe: the gateway replays its receipt
 * without a second send and the turn id is derived from the key, so the merge
 * lands on the same history entry.
 */

import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import {
  coordinateSharedProjectProactiveTurn,
  type SharedProjectProactiveTurn,
} from "../services/shared-runtime/conversation-coordinator";
import {
  NETWORK_PERSONAL_SHARED_PROJECT,
  personalSharedAgentId,
} from "../services/shared-runtime/personal-shared-identity";

export interface NetworkProactiveSendInput {
  userId: string;
  organizationId: string;
  platform: "twilio" | "blooio";
  phoneNumber: string;
  text: string;
  /** Stable per logical send, e.g. `network:intro:<opportunity>:<member>:<attempt>`. */
  idempotencyKey: string;
}

export interface NetworkProactiveSendDeps {
  /** POSTs the body to the gateway's `/internal/deliver`. */
  deliver(body: Record<string, unknown>): Promise<Response>;
  appendHistory(agentId: string, turn: SharedProjectProactiveTurn): Promise<void>;
  now?: () => number;
}

export type NetworkProactiveSendResult =
  | {
      ok: true;
      agentId: string;
      replayed: boolean;
      providerMessageIds: string[];
      historyTurnId: string;
    }
  | {
      ok: false;
      agentId: string;
      status: number;
      /** `unknown` means the provider may have the message; do not resend blindly. */
      acceptance: "not_accepted" | "unknown";
      retryable: boolean;
      code?: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** History turn id derived from the delivery key, so replays merge idempotently. */
export function networkProactiveTurnId(idempotencyKey: string): string {
  return `network-proactive:${idempotencyKey}`;
}

export async function sendNetworkProactiveMessage(
  input: NetworkProactiveSendInput,
  deps: NetworkProactiveSendDeps,
): Promise<NetworkProactiveSendResult> {
  const agentId = personalSharedAgentId({
    userId: input.userId,
    organizationId: input.organizationId,
    project: NETWORK_PERSONAL_SHARED_PROJECT,
  });
  let response: Response;
  try {
    response = await deps.deliver({
      platform: input.platform,
      project: NETWORK_PERSONAL_SHARED_PROJECT,
      phoneNumber: input.phoneNumber,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });
  } catch {
    // error-policy:J1 a transport failure after dispatch may have reached the
    // provider; report unknown acceptance and leave history untouched.
    return { ok: false, agentId, status: 0, acceptance: "unknown", retryable: false };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = record(await response.json());
  } catch {
    // error-policy:J3 an unreadable gateway response is never treated as accepted.
    body = null;
  }
  if (response.status !== 200 || body?.success !== true) {
    return {
      ok: false,
      agentId,
      status: response.status,
      acceptance:
        body?.acceptance === "unknown" || response.status === 202 ? "unknown" : "not_accepted",
      retryable: body?.retryable === true,
      ...(typeof body?.code === "string" ? { code: body.code } : {}),
    };
  }
  const acceptedAt = typeof body.acceptedAt === "string" ? Date.parse(body.acceptedAt) : Number.NaN;
  const historyTurnId = networkProactiveTurnId(input.idempotencyKey);
  await deps.appendHistory(agentId, {
    project: NETWORK_PERSONAL_SHARED_PROJECT,
    userId: input.userId,
    organizationId: input.organizationId,
    id: historyTurnId,
    content: input.text,
    createdAt: Number.isFinite(acceptedAt) ? acceptedAt : (deps.now?.() ?? Date.now()),
  });
  return {
    ok: true,
    agentId,
    replayed: body.replayed === true,
    providerMessageIds: Array.isArray(body.providerMessageIds)
      ? body.providerMessageIds.filter((id): id is string => typeof id === "string")
      : [],
    historyTurnId,
  };
}

/** Production deps: the gateway over HTTP and the Shared conversation namespace. */
export function networkProactiveSendDeps(options: {
  gatewayBaseUrl: string;
  gatewayInternalSecret: string;
  namespace: RuntimeDurableObjectNamespace;
}): NetworkProactiveSendDeps {
  const baseUrl = options.gatewayBaseUrl.replace(/\/+$/, "");
  return {
    deliver: async (body) =>
      await fetch(`${baseUrl}/internal/deliver`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": options.gatewayInternalSecret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }),
    appendHistory: async (agentId, turn) =>
      await coordinateSharedProjectProactiveTurn(agentId, turn, {
        namespace: options.namespace,
      }),
  };
}
