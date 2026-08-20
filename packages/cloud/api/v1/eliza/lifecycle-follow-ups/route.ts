/** Authenticated user-scoped lease and acknowledgement API for in-app lifecycle notices. */

import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg, requireAuthWithOrg } from "@/lib/auth";
import { parseLifecycleCapabilityContinuation } from "@/lib/services/eliza-app/lifecycle-follow-up";
import {
  acknowledgeProactiveGreetings,
  drainProactiveGreetings,
} from "@/lib/services/eliza-app/onboarding-proactive-greeting";
import type { AppEnv } from "@/types/cloud-worker-env";

interface Acknowledgement {
  sessionId: string;
  leaseId: string;
}

type PublicLifecycleEventKind =
  | "workspace_ready"
  | "subscription_upgraded"
  | "connector_connected";

interface PublicLifecycleEvent {
  kind: PublicLifecycleEventKind;
  idempotencyKey: string;
  resourceId: string;
  agentId?: string;
  continuation?: {
    originalIntent: string;
    capabilityId: string;
    clientMessageId?: string;
    requiresConfirmation: true;
  };
}

const PUBLIC_EVENT_KINDS = new Set<PublicLifecycleEventKind>([
  "workspace_ready",
  "subscription_upgraded",
  "connector_connected",
]);

function publicLifecycleEvent(value: unknown): PublicLifecycleEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.kind !== "string" ||
    !PUBLIC_EVENT_KINDS.has(event.kind as PublicLifecycleEventKind) ||
    typeof event.idempotencyKey !== "string" ||
    event.idempotencyKey.length === 0 ||
    event.idempotencyKey.length > 512 ||
    typeof event.resourceId !== "string" ||
    event.resourceId.length === 0 ||
    event.resourceId.length > 256
  ) {
    return null;
  }
  let continuation: PublicLifecycleEvent["continuation"];
  if (event.continuation !== undefined) {
    continuation =
      parseLifecycleCapabilityContinuation(event.continuation) ?? undefined;
    if (!continuation) return null;
  }
  const agentId =
    typeof event.agentId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event.agentId,
    )
      ? event.agentId
      : undefined;
  if (continuation && !agentId) return null;
  return {
    kind: event.kind as PublicLifecycleEventKind,
    idempotencyKey: event.idempotencyKey,
    resourceId: event.resourceId,
    ...(agentId ? { agentId } : {}),
    ...(continuation ? { continuation } : {}),
  };
}

function publicLifecycleNotice(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const notice = value as Record<string, unknown>;
  if (
    typeof notice.sessionId !== "string" ||
    !/^lifecycle:[a-f0-9]{48}$/.test(notice.sessionId) ||
    typeof notice.leaseId !== "string" ||
    !/^[A-Za-z0-9_-]{1,25}$/.test(notice.leaseId) ||
    typeof notice.message !== "string" ||
    notice.message.length === 0 ||
    notice.message.length > 2000 ||
    typeof notice.createdAt !== "string" ||
    !Number.isFinite(Date.parse(notice.createdAt)) ||
    typeof notice.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(notice.expiresAt)) ||
    !Array.isArray(notice.lifecycleEvents) ||
    notice.lifecycleEvents.length === 0 ||
    notice.lifecycleEvents.length > 10
  ) {
    return null;
  }
  const lifecycleEvents = notice.lifecycleEvents.map(publicLifecycleEvent);
  if (lifecycleEvents.some((event) => event === null)) return null;
  return {
    sessionId: notice.sessionId,
    leaseId: notice.leaseId,
    message: notice.message,
    createdAt: notice.createdAt,
    expiresAt: notice.expiresAt,
    lifecycleEvents,
  };
}

function parseAcknowledgements(value: unknown): Acknowledgement[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const parsed: Acknowledgement[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { sessionId, leaseId } = entry as Record<string, unknown>;
    if (
      typeof sessionId !== "string" ||
      !/^lifecycle:[a-f0-9]{48}$/.test(sessionId) ||
      typeof leaseId !== "string" ||
      !/^[A-Za-z0-9_-]{1,25}$/.test(leaseId)
    ) {
      return null;
    }
    parsed.push({ sessionId, leaseId });
  }
  return parsed;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const auth = await requireAuthOrApiKeyWithOrg(c.req.raw);
  let { user } = auth;
  if (auth.authMethod === "api_key") {
    // Lifecycle continuations can contain the user's private original intent.
    // An unscoped machine key is not interactive authority to read or consume
    // that inbox. If browser boot auth supplied both a key and a cookie, the
    // cookie-only helper preserves the authenticated app session.
    if (!c.req.raw.headers.get("cookie")?.trim()) {
      return c.json({ error: "Interactive user session required" }, 403);
    }
    user = await requireAuthWithOrg(c.req.raw);
  }
  // error-policy:J3 malformed authenticated input is rejected explicitly.
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid lifecycle follow-up request" }, 400);
  }
  const input = body as Record<string, unknown>;
  if (input.action === "claim") {
    const leased = await drainProactiveGreetings("in_app", {
      platformUserId: user.id,
    });
    const notices = leased
      .map(publicLifecycleNotice)
      .filter((notice): notice is Record<string, unknown> => notice !== null);
    return c.json({ notices });
  }
  if (input.action === "ack") {
    const acknowledgements = parseAcknowledgements(input.acknowledgements);
    if (!acknowledgements) {
      return c.json({ error: "Invalid lifecycle acknowledgements" }, 400);
    }
    const acknowledged = await acknowledgeProactiveGreetings(
      "in_app",
      acknowledgements,
      { platformUserId: user.id },
    );
    return c.json({ acknowledged });
  }
  return c.json({ error: "Invalid lifecycle follow-up action" }, 400);
});

export default app;
