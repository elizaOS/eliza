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
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b2";
const AGENT_ID = "00000000-0000-4000-8000-0000000000c3";
const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000d4";


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

  // LLM leg: point the REAL eliza-sse-bridge at an OpenAI-compatible streaming
  // chat/completions endpoint. We use OpenRouter (real network, real token SSE,
  // real AbortSignal cancellation) standing in for the funded Cerebras/Eliza
  // SSE (decision §12). The bridge's extra agentId/conversationId body fields
  // are ignored by OpenRouter; the streaming-delta + abort contract is real.
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not set (real LLM leg)");
  process.env.VOICE_REALTIME_ELIZA_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
  process.env.VOICE_REALTIME_ELIZA_AUTHORIZATION = `Bearer ${openrouterKey}`;
  process.env.VOICE_REALTIME_ELIZA_MODEL =
    process.env.HARNESS_LLM_MODEL ?? "meta-llama/llama-3.1-8b-instruct";

  // Provider keys on the env too (harness-real-server passes them explicitly to
  // the session, but the config resolvers also read them off env for parity).
  process.env.DEEPGRAM_API_KEY = providers.deepgramApiKey;
  process.env.CARTESIA_API_KEY = providers.cartesiaApiKey;

  const server = await startRealVoiceServer({
    deepgramApiKey: providers.deepgramApiKey,
    cartesiaApiKey: providers.cartesiaApiKey,
    cartesiaVoiceId: providers.cartesiaVoiceId,
    elizaEndpoint: process.env.VOICE_REALTIME_ELIZA_ENDPOINT,
    elizaAuthorization: process.env.VOICE_REALTIME_ELIZA_AUTHORIZATION,
    organizationId: ORG_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    hooks,
    faultInjection: opts.faultInjection,
  });

  void homedir; // (reserved; keys are read by the CLI provider config)
  return server;
}
