/**
 * The Network service's outbound sends (takeover; thenetwork repo:
 * docs/design/eliza-conversation-layer.md). Signed with SERVICE_TURN_SECRET
 * (`@thenetwork/plugin-network/svc-auth`), idempotent by the request id.
 * Delivery goes through the gateway's /internal/deliver (consent fence,
 * provider idempotency); once accepted, the text is appended to the member's
 * Network agent history, so a later "yes" has the question in context.
 */

import type { DeliverRequest, DeliverResponse } from "@thenetwork/plugin-network/contract";
import { svcVerify } from "@thenetwork/plugin-network/svc-auth";
import { Hono } from "hono";
import { usersRepository } from "@/db/repositories/users";
import { networkProactiveSendDeps, sendNetworkProactiveMessage } from "@/lib/network/proactive-send";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const E164 = /^\+[1-9]\d{6,14}$/;
const APPS = new Set(["ntwrk", "slop", "peon", "friends"]);

function parseDeliver(raw: unknown, id: string): DeliverRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  if (d.id !== id || typeof d.to !== "string" || !E164.test(d.to)) return undefined;
  if (typeof d.text !== "string" || d.text.trim().length === 0 || d.text.length > 1600) return undefined;
  if (typeof d.app !== "string" || !APPS.has(d.app)) return undefined;
  if (d.kind !== "reply" && d.kind !== "proactive" && d.kind !== "relay") return undefined;
  if (d.channel !== undefined && d.channel !== "blooio" && d.channel !== "twilio") return undefined;
  if (d.memberId !== null && typeof d.memberId !== "string") return undefined;
  return d as unknown as DeliverRequest;
}

function gatewayBaseUrl(env: Record<string, unknown>): string | undefined {
  const value = env.ELIZA_APP_WEBHOOK_GATEWAY_URL ?? env.WEBHOOK_GATEWAY_URL ?? env.GATEWAY_WEBHOOK_URL;
  return typeof value === "string" && value ? value.replace(/\/+$/, "") : undefined;
}

type Status = 200 | 400 | 401 | 422 | 502 | 503;

app.post("/", async (c) => {
  const out = (body: DeliverResponse | { ok: false; error: string }, status: Status = 200) => c.json(body, status);
  const env = c.env as unknown as Record<string, unknown>;
  const body = await c.req.text();
  const verified = await svcVerify(env.SERVICE_TURN_SECRET as string | undefined, {
    method: "POST",
    path: new URL(c.req.url).pathname,
    headers: c.req.raw.headers,
    body,
  });
  if (!verified.ok) {
    return out({ ok: false, error: verified.reason }, verified.reason === "no_secret" ? 503 : 401);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    // error-policy:J3 malformed internal input is explicitly invalid.
    return out({ ok: false, error: "invalid", retryable: false }, 400);
  }
  const delivery = parseDeliver(raw, verified.id);
  if (!delivery) return out({ ok: false, error: "invalid", retryable: false }, 400);

  const baseUrl = gatewayBaseUrl(env);
  const secret = env.GATEWAY_INTERNAL_SECRET;
  const namespace = env.SHARED_RUNTIME_CONVERSATIONS;
  if (!baseUrl || typeof secret !== "string" || !secret || !namespace) {
    return out({ ok: false, error: "unknown", retryable: true }, 503);
  }
  const deps = networkProactiveSendDeps({
    gatewayBaseUrl: baseUrl,
    gatewayInternalSecret: secret,
    namespace: namespace as Parameters<typeof networkProactiveSendDeps>[0]["namespace"],
  });
  const platform = delivery.channel ?? "blooio";
  const idempotencyKey = `network:svc:${delivery.id}`;

  const user = await usersRepository.findByPhoneNumberWithOrganization(delivery.to);
  if (!user?.organization_id) {
    // Joined through handled turns only: no Eliza account yet. Deliver
    // without a history append (there is no agent conversation to write to).
    const response = await deps.deliver({
      platform,
      project: "network",
      phoneNumber: delivery.to,
      text: delivery.text,
      idempotencyKey,
    });
    const r = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 200 && r?.success === true) {
      return out({
        ok: true,
        replayed: r.replayed === true,
        providerMessageIds: Array.isArray(r.providerMessageIds) ? r.providerMessageIds.filter((x): x is string => typeof x === "string") : [],
        history: false,
      });
    }
    return out(failure(response.status, r), 502);
  }

  const result = await sendNetworkProactiveMessage(
    { userId: user.id, organizationId: user.organization_id, platform, phoneNumber: delivery.to, text: delivery.text, idempotencyKey },
    deps,
  );
  if (result.ok) {
    return out({ ok: true, replayed: result.replayed, providerMessageIds: result.providerMessageIds, history: true });
  }
  return out(
    {
      ok: false,
      error: result.code === "recipient_opted_out" ? "opted_out" : result.acceptance === "unknown" ? "unknown" : "rejected",
      retryable: result.retryable,
    },
    result.code === "recipient_opted_out" ? 422 : 502,
  );
});

function failure(status: number, r: Record<string, unknown> | null): DeliverResponse {
  return {
    ok: false,
    error: r?.code === "recipient_opted_out" ? "opted_out" : r?.acceptance === "unknown" || status === 202 ? "unknown" : "rejected",
    retryable: r?.retryable === true,
  };
}

export default app;
