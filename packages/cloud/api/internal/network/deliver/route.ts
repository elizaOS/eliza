/**
 * Signed Network service delivery boundary. Account-bound delivery is disabled
 * pending canonical conversation-owned admission through send and history append.
 * Only handled replies to recipients without a Cloud account may use the gateway;
 * those responses explicitly report history:false.
 */

import type {
  DeliverRequest,
  DeliverResponse,
} from "@elizaos/plugin-network/contract";
import { svcVerify } from "@elizaos/plugin-network/svc-auth";
import { Hono } from "hono";
import { usersRepository } from "@/db/repositories/users";
import { networkReplyDelivery } from "@/lib/network/proactive-send";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const E164 = /^\+[1-9]\d{6,14}$/;
const APPS = new Set(["ntwrk", "slop", "peon", "friends"]);

function parseDeliver(raw: unknown, id: string): DeliverRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  if (d.id !== id || typeof d.to !== "string" || !E164.test(d.to))
    return undefined;
  if (
    typeof d.text !== "string" ||
    d.text.trim().length === 0 ||
    d.text.length > 1600
  )
    return undefined;
  if (typeof d.app !== "string" || !APPS.has(d.app)) return undefined;
  if (d.kind !== "reply" && d.kind !== "proactive" && d.kind !== "relay")
    return undefined;
  if (
    d.channel !== undefined &&
    d.channel !== "blooio" &&
    d.channel !== "twilio"
  )
    return undefined;
  if (d.memberId !== null && typeof d.memberId !== "string") return undefined;
  return d as unknown as DeliverRequest;
}

function gatewayBaseUrl(env: Record<string, unknown>): string | undefined {
  const value =
    env.ELIZA_APP_WEBHOOK_GATEWAY_URL ??
    env.WEBHOOK_GATEWAY_URL ??
    env.GATEWAY_WEBHOOK_URL;
  return typeof value === "string" && value
    ? value.replace(/\/+$/, "")
    : undefined;
}

type Status = 200 | 400 | 401 | 422 | 502 | 503;

app.post("/", async (c) => {
  const out = (
    body: DeliverResponse | { ok: false; error: string },
    status: Status = 200,
  ) => c.json(body, status);
  const env = c.env as unknown as Record<string, unknown>;
  const body = await c.req.text();
  const verified = await svcVerify(
    env.SERVICE_TURN_SECRET as string | undefined,
    {
      method: "POST",
      path: new URL(c.req.url).pathname,
      headers: c.req.raw.headers,
      body,
    },
  );
  if (!verified.ok) {
    return out(
      { ok: false, error: verified.reason },
      verified.reason === "no_secret" ? 503 : 401,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    // error-policy:J3 malformed internal input is explicitly invalid.
    return out({ ok: false, error: "invalid", retryable: false }, 400);
  }
  const delivery = parseDeliver(raw, verified.id);
  if (!delivery)
    return out({ ok: false, error: "invalid", retryable: false }, 400);

  if (env.NETWORK_PERSONAL_CONTINUITY_ENABLED !== "true") {
    return out(
      { ok: false, error: "network_personal_continuity_disabled" },
      503,
    );
  }
  const baseUrl = gatewayBaseUrl(env);
  const secret = env.GATEWAY_INTERNAL_SECRET;
  if (!baseUrl || typeof secret !== "string" || !secret) {
    return out({ ok: false, error: "unknown", retryable: true }, 503);
  }
  const deps = networkReplyDelivery({
    gatewayBaseUrl: baseUrl,
    gatewayInternalSecret: secret,
  });
  const platform = delivery.channel ?? "blooio";
  const idempotencyKey = `network:svc:${delivery.id}`;

  const user = await usersRepository.findByPhoneNumberWithOrganization(
    delivery.to,
  );
  if (!user?.organization_id) {
    if (delivery.kind !== "reply")
      return out({ ok: false, error: "rejected", retryable: false }, 422);
    // Joined through handled turns only: no Eliza account yet. Deliver
    // without a history append (there is no agent conversation to write to).
    const response = await deps.deliver({
      platform,
      project: "network",
      phoneNumber: delivery.to,
      text: delivery.text,
      idempotencyKey,
    });
    const r = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (response.status === 200 && r?.success === true) {
      return out({
        ok: true,
        replayed: r.replayed === true,
        providerMessageIds: Array.isArray(r.providerMessageIds)
          ? r.providerMessageIds.filter(
              (x): x is string => typeof x === "string",
            )
          : [],
        history: false,
      });
    }
    return out(failure(response.status, r), 502);
  }

  // No provider dispatch until the canonical DO can hold admission through
  // send and append. A Dedicated lookup or a separate preflight would race
  // cutover/deletion and could leave an accepted send outside the history.
  return out(
    { ok: false, error: "network_personal_delivery_unqualified" },
    503,
  );
});

function failure(
  status: number,
  r: Record<string, unknown> | null,
): DeliverResponse {
  return {
    ok: false,
    error:
      r?.code === "recipient_opted_out"
        ? "opted_out"
        : r?.acceptance === "unknown" || status === 202
          ? "unknown"
          : "rejected",
    retryable: r?.retryable === true,
  };
}

export default app;
