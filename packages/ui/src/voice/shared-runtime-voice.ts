/**
 * Shared-tier voice fallback (#15395 / umbrella #15310 failure mode #11).
 *
 * The PWA voice loop targets agent-container routes (`/api/tts/cloud`,
 * `/api/asr/cloud`) that only exist inside a dedicated agent server. A
 * shared-runtime cloud agent (`node_id: null`, no container, no routable
 * subdomain) 404s on every one of those calls, so voice is structurally
 * unavailable there even though chat works (chat has a server-side
 * shared-runtime proxy; voice does not).
 *
 * This module is the client-side unblock (Option 2 from the issue): when the
 * active agent base is a shared-runtime cloud base
 * (`<cloudApiBase>/api/v1/eliza/agents/<agentId>`), route voice to the cloud
 * API worker's provider-agnostic v1 routes, which DO exist on the worker and
 * are already priced through the credit ledger:
 *
 *   - TTS: POST `<cloudApiBase>/api/v1/voice/tts`  (JSON `{ text, voiceId?, modelId? }` → audio bytes)
 *   - STT: POST `<cloudApiBase>/api/v1/voice/stt`  (multipart `audio` File → `{ transcript }`)
 *
 * The dedicated-tier path is untouched: `sharedRuntimeVoiceOrigin` returns
 * `null` for any non-shared base, so the existing `/api/tts/cloud` /
 * `/api/asr/cloud` calls fire exactly as before when the agent has its own
 * container.
 */

import { getBootConfig } from "../config/boot-config-store";
import { normalizeDirectCloudSharedAgentApiBase } from "../utils/cloud-agent-base";
import { getElizaApiBase } from "../utils/eliza-globals";

/**
 * Derive the cloud API worker origin from a shared-runtime agent base.
 *
 * A shared-runtime base is `<cloudApiBase>/api/v1/eliza/agents/<agentId>`
 * (optionally with a `/bridge` suffix). The v1 voice routes live at the
 * cloud-worker root (`<cloudApiBase>/api/v1/voice/...`), so we strip the
 * `/api/v1/eliza/agents/<agentId>` path back to the origin. `<cloudApiBase>`
 * may itself carry a path prefix (rare), so we remove only the known
 * shared-agent tail, leaving whatever origin+prefix preceded it.
 *
 * Returns `null` for any base that is NOT a shared-runtime agent base
 * (dedicated subdomain, raw bridge IP, control-plane apex, blank) — the caller
 * then keeps the existing dedicated-tier target unchanged.
 */
export function sharedRuntimeVoiceOrigin(
  apiBase: string | null | undefined,
): string | null {
  const raw = apiBase?.trim();
  if (!raw) return null;
  // normalizeDirectCloudSharedAgentApiBase returns the base unchanged when it
  // is NOT a shared-agent path — so a normalize that leaves a matching path is
  // our shared-tier signal.
  const normalized = normalizeDirectCloudSharedAgentApiBase(raw);
  const match = /^(.*)\/api\/v1\/eliza\/agents\/[^/]+$/.exec(
    normalized.replace(/\/+$/, ""),
  );
  if (!match) return null;
  const prefix = match[1].replace(/\/+$/, "");
  // `prefix` is `<origin>` (or `<origin><some-prefix>`); either way the v1
  // voice routes hang off it. Reject a degenerate empty prefix (would build a
  // relative URL that re-resolves against the SPA origin and 404s).
  if (!/^https?:\/\//i.test(prefix)) return null;
  return prefix;
}

/**
 * Resolve the shared-tier voice base for the CURRENT active agent (reads
 * `getElizaApiBase()`), or `null` when the active agent is not shared-tier.
 */
export function currentSharedRuntimeVoiceOrigin(): string | null {
  return sharedRuntimeVoiceOrigin(getElizaApiBase());
}

/**
 * Cheap mic-affordance guard (#15395 part 2).
 *
 * True when voice is expected to work for the CURRENT active agent:
 * - Dedicated tier (`sharedRuntimeVoiceOrigin` is null): always `true` here —
 *   the dedicated `/api/tts/cloud` / `/api/asr/cloud` container routes are the
 *   pre-existing path and their availability is unchanged by this fix, so this
 *   guard must NOT gate them off (that is the composer's existing
 *   `voice.supported` capture check).
 * - Shared tier: `true` when we can derive a usable v1 cloud-worker origin (the
 *   fallback target). With the fallback wired this is the normal case; it only
 *   returns `false` when a shared base yields no resolvable https origin — the
 *   rare "truly unavailable" state where the composer can hide a dead button
 *   instead of rendering a mic that 404s on every press.
 *
 * Deliberately a cheap synchronous check (no network probe): it reflects
 * whether a valid fallback TARGET exists, not whether the server currently has
 * credits/keys — those surface as fail-loud errors at request time as before.
 */
export function isVoiceTargetResolvableForActiveAgent(): boolean {
  const apiBase = getElizaApiBase()?.trim();
  // Dedicated tier / no base yet: not our concern — defer to the existing
  // capture-support gate (return true so we never suppress the dedicated path).
  const sharedOrigin = sharedRuntimeVoiceOrigin(apiBase);
  if (sharedOrigin === null) return true;
  // Shared tier: available iff we resolved a concrete https origin to POST to.
  return /^https?:\/\//i.test(sharedOrigin);
}

/** Build the cloud-worker v1 TTS URL (`<origin>/api/v1/voice/tts`). */
export function sharedRuntimeTtsUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/voice/tts`;
}

/**
 * Resolve the configured Eliza Cloud worker origin from boot config, for
 * forced-cloud voice that must bypass the on-device proxy (#16116).
 *
 * Boot config carries the cloud SITE base (`cloudApiBase`, e.g.
 * `https://elizacloud.ai`, or a staging/custom origin). The provider-agnostic
 * v1 voice routes hang off the bare origin, so we strip a trailing `/api/v1`
 * (some hosts pass the API base with the version path) and any trailing
 * slashes. Returns `null` when boot config has no usable https origin — the
 * caller then keeps the on-device proxy path. Reading from boot config (not a
 * hardcoded production URL) keeps staging/custom cloud environments correct.
 */
export function configuredCloudVoiceOrigin(): string | null {
  const raw = getBootConfig().cloudApiBase?.trim();
  if (!raw) return null;
  const origin = raw
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "")
    .replace(/\/+$/, "");
  return /^https?:\/\//i.test(origin) ? origin : null;
}

/** How a forced-cloud TTS request was routed (drives the request + debug). */
export interface ForcedCloudTtsRoute {
  /** Absolute TTS endpoint to POST `{ text }` to. */
  url: string;
  /** Bearer to send, or `null` to omit the `Authorization` header. */
  bearer: string | null;
  /** Which target was chosen — observability + regression assertions. */
  via: "shared-runtime" | "direct-cloud" | "on-device-proxy";
  /** Voice/model to carry in the direct request body (parity with a caller-known pin). */
  voiceId?: string;
  modelId?: string;
}

/**
 * Decide where forced-cloud (`provider === "eliza-cloud"`) TTS should POST and
 * which bearer to carry.
 *
 * A dedicated/on-device agent otherwise relays TTS through its own
 * `/api/tts/cloud` proxy — an extra audio download through the phone-side event
 * loop plus a base64 IPC re-marshal (~5–6 s/reply on constrained devices, #16116)
 * even though the cloud worker completes in 1–2 s. When a cloud session bearer
 * and a configured cloud origin are both available, POST straight to the cloud
 * worker's v1 voice route instead. Shared-runtime agents (no container) already
 * resolve directly to that route off their active base and are left unchanged
 * (#15395). With no cloud auth/config, the on-device proxy path is preserved.
 *
 * Voice/model parity with the proxy: in the default (unpinned) setup the direct
 * `{ text }` body and the proxy produce the SAME voice — the proxy injects
 * `LEGACY_DEFAULT_ELEVENLABS_VOICE_ID`, which the worker's provider selection
 * (`packages/cloud/api/v1/voice/tts/provider-selection.ts`) explicitly treats
 * as "caller did not pin a voice", identical to an omitted `voiceId`. The
 * residual gap is a server-side `ELIZAOS_CLOUD_TTS_VOICE` / `_MODEL` env pin:
 * those env vars live only in the agent-server process and are exposed through
 * no renderer channel (not boot config, not `VoiceConfig`, not `getConfig()`),
 * so the client cannot detect a pin to route around it. When the caller DOES
 * know a voice/model (any future renderer channel), pass `voiceId`/`modelId`
 * here and the direct body carries them; until then, operators with an env pin
 * get the worker default on the direct path — a documented limitation, and the
 * direct→proxy failure fallback in `useVoiceChat` does not cover it (the direct
 * request succeeds, with the unpinned voice).
 *
 * Pure so the routing decision is unit-testable without a network or DOM.
 */
export function resolveForcedCloudTtsRoute(input: {
  /** On-device proxy target, `resolveApiUrl("/api/tts/cloud")`. */
  proxyUrl: string;
  /** Bearer used for the shared-runtime + proxy paths (active-base token). */
  proxyBearer: string | null;
  /** `currentSharedRuntimeVoiceOrigin()` — non-null only for shared-tier bases. */
  sharedRuntimeOrigin: string | null;
  /** `configuredCloudVoiceOrigin()` — the boot-config cloud worker origin. */
  configuredCloudOrigin: string | null;
  /** `getCloudAuthToken()` — the canonical Steward cloud session bearer. */
  cloudSessionToken: string | null;
  /** Caller-known voice pin to carry in the direct body (parity; see header). */
  voiceId?: string | null;
  /** Caller-known model pin to carry in the direct body (parity; see header). */
  modelId?: string | null;
}): ForcedCloudTtsRoute {
  const {
    proxyUrl,
    proxyBearer,
    sharedRuntimeOrigin,
    configuredCloudOrigin,
    cloudSessionToken,
    voiceId,
    modelId,
  } = input;

  if (sharedRuntimeOrigin) {
    return {
      url: sharedRuntimeTtsUrl(sharedRuntimeOrigin),
      bearer: proxyBearer,
      via: "shared-runtime",
    };
  }

  const token = cloudSessionToken?.trim();
  if (token && configuredCloudOrigin) {
    const pinnedVoice = voiceId?.trim();
    const pinnedModel = modelId?.trim();
    return {
      url: sharedRuntimeTtsUrl(configuredCloudOrigin),
      bearer: token,
      via: "direct-cloud",
      ...(pinnedVoice ? { voiceId: pinnedVoice } : {}),
      ...(pinnedModel ? { modelId: pinnedModel } : {}),
    };
  }

  return { url: proxyUrl, bearer: proxyBearer, via: "on-device-proxy" };
}

/** Build the shared-tier STT URL (`<origin>/api/v1/voice/stt`). */
export function sharedRuntimeSttUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/voice/stt`;
}

/**
 * Adapt a captured WAV into the multipart body the v1 STT route expects.
 *
 * The dedicated `/api/asr/cloud` proxy reads a raw `audio/wav` body and
 * re-wraps it as multipart server-side. The v1 route
 * (`packages/cloud/api/v1/voice/stt/route.ts`) is the multipart endpoint
 * itself: it reads `formData().get("audio")` as a `File` and validates the
 * magic-number signature, so we must post the WAV as a named `audio` File
 * (declared `audio/wav`) here.
 */
export function buildSharedRuntimeSttBody(audio: Uint8Array): FormData {
  const form = new FormData();
  // A fresh ArrayBuffer copy keeps the Blob independent of the caller's view
  // (a shared/detached buffer would corrupt the upload). `.slice()` copies.
  const file = new File([audio.slice().buffer], "speech.wav", {
    type: "audio/wav",
  });
  form.append("audio", file);
  return form;
}

/**
 * Parse the v1 STT response (`{ transcript }`) into the trimmed transcript the
 * client expects. The dedicated proxy returns `{ text }`; the v1 route returns
 * `{ transcript }`, so this reads `transcript` (and tolerates `text` as a
 * defensive fallback). Returns `""` for a missing/blank transcript — the caller
 * enforces the fail-loud empty-transcript contract.
 */
export function parseSharedRuntimeSttResponse(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as { transcript?: unknown; text?: unknown };
  const value =
    typeof record.transcript === "string"
      ? record.transcript
      : typeof record.text === "string"
        ? record.text
        : "";
  return value.trim();
}
