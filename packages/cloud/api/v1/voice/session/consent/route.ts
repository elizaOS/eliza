// Issues a voice-session consent nonce (SEC-21 mint precondition).
import { Hono } from "hono";

import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  isVoiceRealtimeWsEnabled,
  type VoiceRealtimeEnv,
} from "@/lib/voice-session/config";
import {
  isConsentStoreConfigured,
  issueConsentNonce,
} from "@/lib/voice-session/consent-nonce";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/v1/voice/session/consent (SEC-21).
 *
 * The visible consent action calls this to obtain a one-time nonce, which the
 * mint (`POST /api/v1/voice/session`) then requires and consumes. This makes a
 * verified nonce a SERVER-ENFORCED precondition of minting a paid voice session
 * (SEC-21/AM2): the mint refuses without one, so a session cannot be created by
 * merely promising consent in the mint body.
 *
 * SCOPE BOUNDARY (honest): this endpoint enforces the MECHANISM (a nonce must be
 * issued here and consumed at mint), which is what the threat model requires as
 * the server-side gate. It does NOT itself prove a human performed the visible
 * consent gesture — that attestation (the actual UI affordance / indicator) is
 * the client seat's responsibility and, for a hardened deployment, this handler
 * is the attach point for stronger evidence (e.g. a signed UI-gesture token or
 * app-attestation) before issuing the nonce. Until that evidence is wired, a
 * caller holding the user's own bearer can obtain a nonce; the value delivered
 * here is the enforced separation of the consent step from the mint, not proof
 * of the gesture. Flagged rather than overclaimed.
 *
 * The nonce is scoped to the authenticated user and single-use with a short
 * TTL. When no durable store is configured, consent cannot be honestly tracked,
 * so this returns 503 rather than issuing an untracked nonce.
 */

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const env = c.env as unknown as VoiceRealtimeEnv;
  if (!isVoiceRealtimeWsEnabled(env)) {
    return c.json({ error: "voice realtime session not enabled" }, 404);
  }
  if (!isConsentStoreConfigured()) {
    return c.json({ error: "consent store not configured" }, 503);
  }

  const auth = await requireUserOrApiKeyWithOrg(c);
  const issued = await issueConsentNonce(auth.id);
  if (!issued) {
    return c.json({ error: "consent store not configured" }, 503);
  }
  return c.json({ consentNonce: issued.nonce, expiresAt: issued.expiresAt });
});

export default app;
