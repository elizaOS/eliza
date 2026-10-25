/**
 * Signed Network service delivery enters the canonical Personal conversation
 * owner before external I/O. Receipt reconciliation shares that owner and
 * never dispatches a missing or merely prepared intent. Activation defaults off.
 */

import { usersRepository } from "@elizaos/cloud-shared/db/repositories/users";
import { coordinateNetworkDelivery } from "@elizaos/cloud-shared/lib/services/shared-runtime/conversation-coordinator";
import {
  type NetworkAdmissionEnvelope,
  networkAccountMatchesPolicy,
  verifyNetworkServiceDeliveryEnvelope,
} from "@elizaos/cloud-shared/lib/services/shared-runtime/network-shared-admission";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-identity";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import {
  type DeliverRequest,
  type DeliverResponse,
  parseApprovedRelayPhotos,
} from "@elizaos/plugin-network/contract";
import { svcVerify } from "@elizaos/plugin-network/svc-auth";
import { type Context, Hono } from "hono";

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
  if (d.approvedPhotos !== undefined) {
    const photos = parseApprovedRelayPhotos(d.approvedPhotos);
    // This public consumer has no QA route-policy authority. Do not fall back to default custody.
    if (
      !photos ||
      Object.keys(d).some(
        (k) =>
          ![
            "id",
            "to",
            "from",
            "text",
            "app",
            "memberId",
            "channel",
            "kind",
            "approvedPhotos",
          ].includes(k),
      ) ||
      d.kind !== "relay" ||
      d.channel === "twilio" ||
      typeof d.memberId !== "string" ||
      "networkAuthority" in d ||
      "networkParentTurn" in d ||
      "policyReply" in d ||
      photos.some(
        (p) =>
          p.app !== d.app ||
          p.recipientMemberId !== d.memberId ||
          `relay:${p.itemId}` !== d.id,
      )
    )
      return undefined;
    return { ...d, approvedPhotos: photos } as unknown as DeliverRequest;
  }
  return d as unknown as DeliverRequest;
}

type Status = 200 | 202 | 400 | 401 | 403 | 422 | 502 | 503;

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
  const canonicalEnvelope: NetworkAdmissionEnvelope | undefined =
    c.env.NETWORK_OWNED_INGRESS_POLICY !== undefined
      ? {
          originalBody: body,
          path: new URL(c.req.url).pathname,
          signatureHeaders: Object.fromEntries(
            ["x-ntwrk-svc-ts", "x-ntwrk-svc-id", "x-ntwrk-svc-sig"].map((k) => [
              k,
              c.req.raw.headers.get(k) ?? "",
            ]),
          ),
        }
      : undefined;
  const canonical = canonicalEnvelope
    ? await verifyNetworkServiceDeliveryEnvelope(canonicalEnvelope, c.env)
    : undefined;
  if (canonicalEnvelope && !canonical)
    return out({ ok: false, error: "invalid", retryable: false }, 403);
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
  if (canonical) {
    const agentId = personalSharedAgentId({
      userId: user.id,
      organizationId: user.organization_id,
    });
    if (
      user.phone_number !== delivery.to ||
      !user.phone_verified ||
      !user.is_active ||
      user.deleted_at ||
      !user.organization?.is_active ||
      !networkAccountMatchesPolicy(
        {
          userId: user.id,
          organizationId: user.organization_id,
          agentId,
          roomId: agentId,
        },
        canonical.policy,
      )
    )
      return reconcileOnly
        ? out({ ok: false, error: "unknown", retryable: false }, 202)
        : out({ ok: false, error: "rejected", retryable: false }, 422);
  }
  return await coordinateNetworkDelivery(
    {
      project: canonical?.policy.project ?? "network",
      ...(canonical
        ? { connectorAccountId: canonical.policy.connectorAccountId }
        : {}),
      app: delivery.app,
      userId: user.id,
      organizationId: user.organization_id,
      phoneNumber: delivery.to,
      platform: delivery.channel ?? "blooio",
      idempotencyKey: `network:svc:${delivery.id}`,
      text: delivery.text,
      ...(delivery.approvedPhotos
        ? { approvedPhotos: delivery.approvedPhotos }
        : {}),
    },
    {
      namespace,
      ...(canonicalEnvelope
        ? { trustedNetworkServiceDelivery: canonicalEnvelope }
        : {}),
      ...(reconcileOnly ? { reconcileOnly: true as const } : {}),
    },
  );
}

app.post("/", (c) => handleNetworkDelivery(c));

export default app;
