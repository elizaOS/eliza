/**
 * Signed Network service delivery enters the canonical Personal conversation
 * owner before external I/O. Receipt reconciliation shares that owner and
 * never dispatches a missing or merely prepared intent. Activation defaults off.
 */

import type {
  DeliverRequest,
  DeliverResponse,
} from "@elizaos/plugin-network/contract";
import { svcVerify } from "@elizaos/plugin-network/svc-auth";
import { type Context, Hono } from "hono";
import { usersRepository } from "@/db/repositories/users";
import { coordinateNetworkDelivery } from "@/lib/services/shared-runtime/conversation-coordinator";
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

type Status = 200 | 202 | 400 | 401 | 422 | 502 | 503;

export async function handleNetworkDelivery(
  c: Context<AppEnv>,
  reconcileOnly = false,
) {
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
  const namespace = c.env.SHARED_RUNTIME_CONVERSATIONS;
  if (!namespace)
    return out({ ok: false, error: "unknown", retryable: true }, 503);
  const user = await usersRepository.findByPhoneNumberWithOrganization(
    delivery.to,
  );
  // Proactive and relay traffic never provisions a phone account. First-contact
  // account creation belongs only to the gateway-attested handled-turn path.
  if (!user?.organization_id)
    return reconcileOnly
      ? out({ ok: false, error: "unknown", retryable: false }, 202)
      : out({ ok: false, error: "rejected", retryable: false }, 422);
  return await coordinateNetworkDelivery(
    {
      project: "network",
      app: delivery.app,
      userId: user.id,
      organizationId: user.organization_id,
      phoneNumber: delivery.to,
      platform: delivery.channel ?? "blooio",
      idempotencyKey: `network:svc:${delivery.id}`,
      text: delivery.text,
    },
    { namespace, ...(reconcileOnly ? { reconcileOnly: true as const } : {}) },
  );
}

app.post("/", (c) => handleNetworkDelivery(c));

export default app;
