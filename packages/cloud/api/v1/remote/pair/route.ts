/**
 * POST /api/v1/remote/pair
 *
 * T9a — Remote-control control plane.
 *
 * An authenticated owner requests a pairing token for one of their agents.
 * The returned token is a short-lived 6-digit pairing code intended for
 * out-of-band entry into the local agent. Cloud persists only a session-bound
 * keyed verifier and the authoritative expiry.
 *
 * Body: { agentId: string }
 * Returns: { code, expiresAt, sessionId, status }
 *
 * This endpoint reserves a `pending` remote_sessions row. The session is
 * promoted to `active` when the agent consumes the code through the remote
 * session transport, or expires if the code is never consumed.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  deriveRemotePairingCodeVerifier,
  isRemotePairingUuid,
} from "@/db/crypto/remote-pairing-code";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";

const PAIRING_CODE_TTL_SECONDS = 5 * 60;

function generatePairingCode(): string {
  // Rejection sampling avoids modulo bias in the human-entered code space.
  const codeSpace = 1_000_000;
  const acceptedRange = Math.floor(2 ** 32 / codeSpace) * codeSpace;
  const buf = new Uint32Array(1);
  let sample: number;
  do {
    crypto.getRandomValues(buf);
    sample = buf[0] ?? acceptedRange;
  } while (sample >= acceptedRange);
  const n = sample % codeSpace;
  return n.toString().padStart(6, "0");
}

interface PairRequestBody {
  agentId?: unknown;
  hostId?: unknown;
}

const app = new Hono<AppEnv>();

const p256PublicJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(40).max(50),
    y: z.string().min(40).max(50),
    d: z.never().optional(),
  })
  .passthrough();

const consumePairingSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  controller: z.object({
    deviceId: z.string().trim().min(1).max(256),
    keyId: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(120),
    platform: z.enum(["ios", "macos", "windows", "linux", "android", "web"]),
    signingPublicKeyJwk: p256PublicJwkSchema,
    encryptionPublicKeyJwk: p256PublicJwkSchema,
  }),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

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

    let body: PairRequestBody;
    try {
      body = (await c.req.json()) as PairRequestBody;
    } catch {
      // error-policy:J3 malformed request JSON is an explicit client error.
      return c.json(
        { success: false, error: "Request body must be valid JSON" },
        400,
      );
    }
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const hostId = typeof body.hostId === "string" ? body.hostId.trim() : "";
    if (Boolean(agentId) === Boolean(hostId)) {
      return c.json(
        {
          success: false,
          error: "Exactly one of agentId or hostId is required",
        },
        400,
      );
    }
    const targetId = agentId || hostId;
    if (!isRemotePairingUuid(targetId)) {
      return c.json(
        {
          success: false,
          error: `${agentId ? "agentId" : "hostId"} must be a UUID`,
        },
        400,
      );
    }

    const code = generatePairingCode();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000);
    const tokenHash = await deriveRemotePairingCodeVerifier(
      pairingSecret,
      {
        organizationId: user.organization_id,
        userId: user.id,
        agentId: targetId,
        sessionId,
      },
      code,
      expiresAt,
    );

    const pending = {
      id: sessionId,
      organization_id: user.organization_id,
      user_id: user.id,
      status: "pending",
      requester_identity: user.id,
      pairing_token_hash: tokenHash,
    } as const;
    const session = agentId
      ? await remoteSessionsRepository.createPendingForOwnedAgent({
          ...pending,
          agent_id: agentId,
        })
      : await remoteSessionsRepository.createPendingForOwnedHost({
          ...pending,
          host_id: hostId,
        });
    if (!session) {
      return c.json(
        {
          success: false,
          error: agentId ? "Agent not found" : "Host not found",
        },
        404,
      );
    }

    c.header(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json({
      success: true,
      data: {
        sessionId: session.id,
        code,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: PAIRING_CODE_TTL_SECONDS,
        status: session.status,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

app.post("/consume", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
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
    const parsed = consumePairingSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "A six-digit code and P-256 controller identity are required",
        },
        400,
      );
    }
    const result = await remoteSessionsRepository.consumePendingForOwner({
      organizationId: user.organization_id,
      userId: user.id,
      code: parsed.data.code,
      pairingSecret,
      controller: parsed.data.controller,
    });
    if (result.kind === "ambiguous") {
      return c.json(
        {
          success: false,
          error:
            "Code collision; create a new pairing code on the target device",
          code: "REMOTE_PAIRING_CODE_AMBIGUOUS",
        },
        409,
      );
    }
    if (result.kind === "invalid") {
      return c.json(
        { success: false, error: "Invalid or expired pairing code" },
        401,
      );
    }
    const targetHost = result.session.host_id
      ? await remoteHostsRepository.getOwned(
          result.session.host_id,
          user.organization_id,
          user.id,
        )
      : undefined;
    if (result.session.host_id && !targetHost) {
      return c.json(
        { success: false, error: "Target host is unavailable" },
        410,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        sessionId: result.session.id,
        ownerId: result.session.user_id,
        agentId: result.session.agent_id,
        hostId: result.session.host_id,
        status: result.session.status,
        ingressUrl: result.session.ingress_url,
        targetDisplayName: targetHost?.display_name ?? null,
        targetIdentity: targetHost
          ? {
              keyId: targetHost.runtime_key_id,
              signingPublicKeyJwk: targetHost.signing_public_jwk,
              encryptionPublicKeyJwk: targetHost.encryption_public_jwk,
            }
          : null,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
