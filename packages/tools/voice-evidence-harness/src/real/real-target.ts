/**
 * REAL-target bridge for the evidence harness (`--target=real`).
 *
 * Boots the ACTUAL Phase-1 voice-session server code (the mint consent+JWT
 * precondition chain, `attachVoiceWsHandler`, `VoiceSession`, and the merged
 * Deepgram/Cartesia adapters) via the api-package's harness boot module
 * (`v1/voice/session/lib/harness-real-server.ts`), driving LIVE providers.
 *
 * This module's ONLY job is environment setup + provider-key/endpoint wiring;
 * it reimplements no voice logic. See harness-real-server.ts for the exact
 * REAL-vs-SHIMMED boundary (transport-only shim, everything security-relevant
 * runs unmodified).
 *
 * The `@/...` alias imports inside harness-real-server.ts resolve against the
 * api-package tsconfig (bun resolves aliases per-file), so importing it across
 * the package boundary works.
 */

import { homedir } from "node:os";

import type { ProviderConfig } from "../reference/voice-session-server.ts";
import {
  startRealVoiceServer,
  installHarnessSigningKey,
  type RunningRealServer,
} from "../../../../cloud/api/v1/voice/session/lib/harness-real-server.ts";

export interface RealTargetHooks {
  log: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

export interface StartRealTargetOptions {
  providers: ProviderConfig;
  faultInjection?: "deepgram-auth-fail";
  hooks: RealTargetHooks;
}

export type RealTargetHandle = RunningRealServer;

// Fixed authed identity for the run. The REAL scoped-JWT is minted for these
// claims and the WS handler verifies the token against them; the ownership/auth
// checks are a PLATFORM seam (see harness-real-server.ts SHIM 5), bypassed here
// by driving the real consent+jwt mint chain directly.


export async function startRealTarget(
  opts: StartRealTargetOptions,
): Promise<RealTargetHandle> {
  const { providers, hooks } = opts;

  // --- environment the REAL config/redis/jwks code reads (getCloudAwareEnv
  // falls back to process.env outside a Worker request) ---
  await installHarnessSigningKey();

  // SHIM 3: in-memory Lua-capable Redis so the REAL consent/claim/revoke/dir +
  // durable metering paths run against a real store interface.
  process.env.MOCK_REDIS = "1";

  // The flag's REAL consumer working (VOICE_REALTIME_WS_ENABLED=true).
  process.env.VOICE_REALTIME_WS_ENABLED = "true";
  process.env.VOICE_REALTIME_CARTESIA_VOICE_ID = providers.cartesiaVoiceId;

  // Agent leg: evidence must exercise the same canonical persisted conversation
  // route as staging. A raw model gateway can produce audio while silently
  // bypassing the selected agent and conversation, so it is not a valid target.
  const elizaApiOrigin = process.env.VOICE_REALTIME_ELIZA_ENDPOINT;
  const elizaAuthorization = process.env.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  if (!elizaApiOrigin) {
    throw new Error("VOICE_REALTIME_ELIZA_ENDPOINT API origin not set (real agent leg)");
  }
  if (!elizaAuthorization) {
    throw new Error("VOICE_REALTIME_ELIZA_AUTHORIZATION not set (real agent leg)");
  }
  const agentId = process.env.HARNESS_AGENT_ID;
  const conversationId = process.env.HARNESS_CONVERSATION_ID;
  const organizationId = process.env.HARNESS_ORGANIZATION_ID;
  const userId = process.env.HARNESS_USER_ID;
  if (!agentId || !conversationId || !organizationId || !userId) {
    throw new Error(
      "HARNESS_AGENT_ID, HARNESS_CONVERSATION_ID, HARNESS_ORGANIZATION_ID, and HARNESS_USER_ID must match an existing authorized conversation",
    );
  }

  // Provider keys on the env too (harness-real-server passes them explicitly to
  // the session, but the config resolvers also read them off env for parity).
  process.env.DEEPGRAM_API_KEY = providers.deepgramApiKey;
  process.env.CARTESIA_API_KEY = providers.cartesiaApiKey;

  const server = await startRealVoiceServer({
    deepgramApiKey: providers.deepgramApiKey,
    cartesiaApiKey: providers.cartesiaApiKey,
    cartesiaVoiceId: providers.cartesiaVoiceId,
    elizaEndpoint: elizaApiOrigin,
    elizaAuthorization,
    organizationId,
    userId,
    agentId,
    conversationId,
    hooks,
    faultInjection: opts.faultInjection,
  });

  void homedir; // (reserved; keys are read by the CLI provider config)
  return server;
}
