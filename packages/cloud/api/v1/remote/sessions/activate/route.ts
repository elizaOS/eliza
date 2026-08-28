/** Atomically discovers and consumes one host-bound pairing code. */

import { Hono } from "hono";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  getIpKey,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseRemoteHostCredential } from "../../host-auth";

const app = new Hono<AppEnv>();
const MAX_ACTIVATION_BODY_BYTES = 64;
const ACTIVATION_WINDOW_MS = 5 * 60_000;

// Both limiters are shared-Redis backed, observe every request (no local
// verdict lease), and fail closed if Redis is unavailable. The source bucket
// prevents high-cardinality host ids from becoming a limiter bypass; the host
// bucket prevents a botnet from concentrating guesses on one enrolled host.
app.use(
  "*",
  rateLimit({
    windowMs: ACTIVATION_WINDOW_MS,
    maxRequests: 20,
    keyGenerator: (c) => `remote-activation:source:${getIpKey(c)}`,
    localLease: false,
    failClosed: true,
  }),
);
app.use(
  "*",
  rateLimit({
    windowMs: ACTIVATION_WINDOW_MS,
    maxRequests: 5,
    keyGenerator: (c) =>
      `remote-activation:host:${c.req.header("x-remote-host-id")?.trim() || "missing"}`,
    localLease: false,
    failClosed: true,
  }),
);

type ActivationBodyReadResult =
  | { kind: "ok"; value: unknown }
  | { kind: "invalid" }
  | { kind: "too_large" };

async function readActivationBody(
  request: Request,
): Promise<ActivationBodyReadResult> {
  const declaredLength = request.headers.get("content-length");
  if (/^\d+$/.test(declaredLength ?? "")) {
    try {
      if (BigInt(declaredLength ?? "0") > BigInt(MAX_ACTIVATION_BODY_BYTES)) {
        await request.body?.cancel();
        return { kind: "too_large" };
      }
    } catch {
      // error-policy:J3 an unparseable transport hint falls through to the
      // authoritative streamed byte count.
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_ACTIVATION_BODY_BYTES) {
        await reader.cancel();
        return { kind: "too_large" };
      }
      chunks.push(item.value);
    }
  } catch {
    // error-policy:J3 unreadable request bytes are malformed client input.
    return { kind: "invalid" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    // error-policy:J3 invalid UTF-8 and malformed JSON are explicit client errors.
    return { kind: "invalid" };
  }
}

app.post("/", async (c) => {
  try {
    const credential = parseRemoteHostCredential(c.req.raw);
    if (!credential) {
      return c.json(
        { success: false, error: "Remote host authentication required" },
        401,
      );
    }
    const pairingSecret = c.env.REMOTE_PAIRING_HMAC_SECRET?.trim();
    if (
      !pairingSecret ||
      new TextEncoder().encode(pairingSecret).byteLength < 32
    ) {
      return c.json(
        {
          success: false,
          error: "Remote pairing is unavailable",
          code: "REMOTE_PAIRING_NOT_CONFIGURED",
        },
        503,
      );
    }
    const mediaType = (c.req.header("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      return c.json(
        { success: false, error: "Content-Type must be application/json" },
        415,
      );
    }
    const body = await readActivationBody(c.req.raw);
    if (body.kind === "too_large") {
      return c.json(
        { success: false, error: "Request body exceeds 64 bytes" },
        413,
      );
    }
    if (body.kind === "invalid") {
      return c.json(
        { success: false, error: "Request body must be valid JSON" },
        400,
      );
    }
    const value = body.value;
    const exactBody =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, "code");
    const code = exactBody
      ? (value as Record<string, unknown>).code
      : undefined;
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return c.json(
        { success: false, error: "code must contain exactly six digits" },
        400,
      );
    }

    const result = await remoteSessionsRepository.activatePendingHostByCode({
      hostId: credential.hostId,
      hostToken: credential.token,
      code,
      pairingSecret,
    });
    if (result.kind !== "activated") {
      return c.json(
        { success: false, error: "Pairing session not found or invalid" },
        404,
      );
    }
    const session = result.session;
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        sessionId: session.id,
        grantId: session.grant_id,
        grantRevision: session.grant_revision,
        ownerId: session.user_id,
        controllerDeviceId: session.controller_device_id,
        controllerKeyId: session.controller_key_id,
        controllerDisplayName: session.controller_display_name,
        controllerPlatform: session.controller_platform,
        controllerSigningPublicKeyJwk: session.controller_signing_public_jwk,
        controllerEncryptionPublicKeyJwk:
          session.controller_encryption_public_jwk,
        targetRuntimeId: session.host_id,
        targetKeyId: session.target_key_id,
        controllerCreatedAt: session.created_at,
        grantExpiresAt: session.grant_expires_at,
        status: session.status,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;

export const activationRouteInternals = {
  ACTIVATION_WINDOW_MS,
  MAX_ACTIVATION_BODY_BYTES,
  readActivationBody,
};
