/** Exact-reader access to one server-authorized private capture session. */

import {
  requireAdmin,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-identity";
import { parseOwnerCapturePolicy } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-owner-model-capture-store";
import { sharedRuntimeRoomKey } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-chat";
import { normalizeSharedRuntimeRoom } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-room-identity";
import { sharedRuntimeConversationRoomId } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-storage-identity";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  Vary: "Authorization, Cookie",
  "Referrer-Policy": "no-referrer",
};
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS))
    c.header(name, value);
  await next();
});
app.on(["GET", "POST"], "/read", bodyLimit({ maxSize: 4096 }), async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);
  const policyValue = (c.env as unknown as Record<string, unknown>)
    .SHARED_OWNER_MODEL_CAPTURE_POLICY;
  const policy = parseOwnerCapturePolicy(policyValue);
  if (!policy) return c.json({ error: "Capture session unavailable" }, 404);
  if (user.id !== policy.readerUserId)
    return c.json({ error: "Capture reader not authorized" }, 403);
  // An app-issued key identifies its issuer but grants no private capture access.
  const apiKeyId = c.get("apiKeyId");
  if (apiKeyId) {
    const { appsService } = await import(
      "@elizaos/cloud-shared/lib/services/apps"
    );
    if (await appsService.getByApiKeyId(apiKeyId))
      return c.json({ error: "Capture reader not authorized" }, 403);
  }
  const ownerReader = user.id === policy.userId;
  if (ownerReader) {
    if (user.organization_id !== policy.organizationId) {
      return c.json({ error: "Capture reader not authorized" }, 403);
    }
  } else {
    const admin = await requireAdmin(c);
    if (admin.user.id !== user.id)
      return c.json({ error: "Capture reader not authorized" }, 403);
  }

  let body: unknown;
  if (c.req.method === "GET") {
    // UUID locators are not authorization. Browser reads still use the exact
    // authenticated policy reader and the same canonical owner/room/store gates.
    const url = new URL(c.req.url);
    const query = url.searchParams;
    if (
      new TextEncoder().encode(url.search).byteLength > 4096 ||
      !["sessionId", "captureId,sessionId"].includes(
        [...query.keys()].sort().join(","),
      )
    ) {
      return c.json({ error: "Invalid capture request" }, 400);
    }
    body = {
      sessionId: query.get("sessionId"),
      ...(query.has("captureId") ? { captureId: query.get("captureId") } : {}),
      // Native Personal DM uses its canonical personal agent id as the raw room.
      // GET intentionally cannot choose another conversation or carry private text.
      roomKey: personalSharedAgentId({
        organizationId: policy.organizationId,
        userId: policy.userId,
      }),
    };
  } else {
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid capture request" }, 400);
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid capture request" }, 400);
  }
  const request = body as Record<string, unknown>;
  if (
    !["roomKey,sessionId", "captureId,roomKey,sessionId"].includes(
      Object.keys(request).sort().join(","),
    ) ||
    typeof request.sessionId !== "string" ||
    !UUID.test(request.sessionId) ||
    (request.captureId !== undefined &&
      (typeof request.captureId !== "string" ||
        !UUID.test(request.captureId))) ||
    typeof request.roomKey !== "string" ||
    request.roomKey.trim().length === 0 ||
    request.roomKey.length > 512 ||
    /\p{Cc}/u.test(request.roomKey)
  ) {
    return c.json({ error: "Invalid capture request" }, 400);
  }
  if (request.sessionId !== policy.sessionId)
    return c.json({ error: "Capture session unavailable" }, 404);
  const roomKey = normalizeSharedRuntimeRoom(request.roomKey);
  const agentId = personalSharedAgentId({
    organizationId: policy.organizationId,
    userId: policy.userId,
  });
  // Use the exact same two-stage channel/storage identity as the live Shared turn.
  const storageRoomId = sharedRuntimeConversationRoomId(
    sharedRuntimeRoomKey(agentId, roomKey),
  );
  if (storageRoomId !== policy.roomId)
    return c.json({ error: "Capture room unavailable" }, 404);
  const namespace = c.env.SHARED_RUNTIME_CONVERSATIONS;
  if (!namespace || typeof namespace.getByName !== "function") {
    return c.json({ error: "Capture storage unavailable" }, 503);
  }
  try {
    const response = await namespace
      .getByName(`${agentId}:${roomKey}`)
      .fetch("https://shared-runtime.internal/owner-capture/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: policy.sessionId,
          ...(request.captureId === undefined
            ? {}
            : { captureId: request.captureId }),
          readerUserId: user.id,
          verifiedAdmin: !ownerReader,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    // The DO independently authorizes its cached canonical owner/room and the
    // original durable reservation, and bounds decryption to the original policy.
    return new Response(response.body, {
      status: response.status,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch {
    return c.json({ error: "Capture read unavailable" }, 503);
  }
});
export default app;
