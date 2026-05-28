/**
 * Voice profile client (R10 §5.3).
 *
 * Adapter layer between the UI surfaces and the server-side speaker-id +
 * voice-profile endpoints I2 owns. R10 ships a stable internal
 * `VoiceProfile` shape; the adapter remaps once I2's server schema lands.
 *
 * **Defensive design:** every read returns an empty list / null on failure
 * so the UI compiles and renders before the server endpoints exist. Once
 * I2 lands the server side, the adapter swaps the fake fallbacks for real
 * HTTP calls without touching the consumers.
 */

export type VoiceProfileCohort = "owner" | "family" | "guest" | "unknown";
export type VoiceProfileSource = "first-run" | "auto-clustered" | "manual";

/**
 * Stable internal shape consumed by `VoiceProfileSection` and the first-run
 * voice steps. Mirrors R10 §5.1 — keep wide-compatible fields here, narrow
 * server-specific fields in the adapter.
 */
export interface VoiceProfile {
  /** Stable profile id (server-issued, opaque). */
  id: string;
  /** Bound entity id if speaker-id has matched the profile to an entity. */
  entityId: string | null;
  /** Display name shown in the manager UI. */
  displayName: string;
  /** Optional relationship label (e.g. "wife", "colleague"). */
  relationshipLabel: string | null;
  /** True when this profile owns the OWNER role on the device. */
  isOwner: boolean;
  /** Number of distinct utterances learned from. */
  embeddingCount: number;
  /** Epoch millis of the first utterance. */
  firstHeardAtMs: number;
  /** Epoch millis of the most recent utterance. */
  lastHeardAtMs: number;
  cohort: VoiceProfileCohort;
  source: VoiceProfileSource;
  /** Optional retention window: forget the profile after N days idle. */
  retentionDays?: number | null;
  /** Optional preview audio uri (server-signed; UI fetches via client.fetch). */
  samplePreviewUri?: string | null;
}

/** Capture step description supplied by I2 during first-run (R10 §3.2 step 5). */
export interface VoiceCapturePrompt {
  id: string;
  text: string;
  /** Recommended capture window in seconds. */
  targetSeconds: number;
}

export interface VoiceCaptureSession {
  sessionId: string;
  prompts: VoiceCapturePrompt[];
  /** Approx total capture seconds the agent expects (sum of prompts). */
  expectedSeconds: number;
}

export interface VoiceCaptureSubmitResult {
  profileId: string;
  entityId: string;
  isOwner: boolean;
}

export interface VoiceProfileMergeRequest {
  intoId: string;
}

export interface VoiceProfileSplitRequest {
  utteranceIds: string[];
}

export interface VoiceProfilePatch {
  displayName?: string;
  relationshipLabel?: string | null;
  retentionDays?: number | null;
}

export interface FamilyMemberCapturePayload {
  /** Raw base64-encoded audio blob (webm / wav / ogg). */
  audioBase64: string;
  /** Client-measured capture duration in milliseconds. */
  durationMs: number;
  /** Display name for the family member, e.g. "Alex". */
  displayName: string;
  /** Free-form relationship label, e.g. "spouse", "colleague". */
  relationship: string;
  /** Owner entity id — stored as the relationship source on the profile. */
  ownerEntityId?: string | null;
}

export interface FamilyMemberCaptureResult {
  /** Content-addressed voice profile id (`vp_<sha>`). */
  profileId: string;
  /** Newly minted entity id for the family member. */
  entityId: string;
  displayName: string;
  relationship: string;
  /** Canonical relationship tag written to profile metadata. */
  relationshipTag: "family_of";
  ownerEntityId: string | null;
}

/**
 * Single failure context used by every adapter call so the UI can render a
 * stable empty state instead of a generic toast/spinner.
 */
export class VoiceProfilesUnavailableError extends Error {
  constructor(
    readonly endpoint: string,
    readonly cause?: unknown,
  ) {
    super(`Voice profiles endpoint unavailable: ${endpoint}`);
    this.name = "VoiceProfilesUnavailableError";
  }
}

interface VoiceProfilesClientLike {
  fetch<T>(path: string, init?: RequestInit): Promise<T>;
}

/**
 * Adapter facade — keep the public surface narrow so the UI doesn't bind
 * to optional fields the server might omit.
 */
export class VoiceProfilesClient {
  constructor(private readonly client: VoiceProfilesClientLike) {}

  /** List all known profiles. Returns `[]` when the endpoint isn't available. */
  async list(): Promise<VoiceProfile[]> {
    try {
      const raw = await this.client.fetch<{ profiles?: unknown[] } | unknown[]>(
        "/api/voice/profiles",
      );
      const items = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { profiles?: unknown[] })?.profiles)
          ? ((raw as { profiles?: unknown[] }).profiles ?? [])
          : [];
      return items.map(normaliseProfile).filter(isProfile);
    } catch (err) {
      if (isMissingEndpointError(err)) return [];
      throw new VoiceProfilesUnavailableError("/api/voice/profiles", err);
    }
  }

  /** Start first-run capture for the OWNER profile. */
  async startOwnerCapture(): Promise<VoiceCaptureSession> {
    try {
      const raw = await this.client.fetch<unknown>(
        "/api/voice/first-run/profile/start",
        { method: "POST" },
      );
      return normaliseCaptureSession(raw);
    } catch (err) {
      if (isMissingEndpointError(err)) {
        return fallbackCaptureSession();
      }
      throw new VoiceProfilesUnavailableError(
        "/api/voice/first-run/profile/start",
        err,
      );
    }
  }

  /** Append a captured audio chunk to an in-progress first-run session. */
  async appendOwnerCapture(
    sessionId: string,
    payload: { promptId: string; audioBase64: string; durationMs: number },
  ): Promise<void> {
    try {
      await this.client.fetch(
        `/api/voice/first-run/profile/append?id=${encodeURIComponent(sessionId)}`,
        { method: "POST", body: JSON.stringify(payload) },
      );
    } catch (err) {
      if (isMissingEndpointError(err)) return;
      if (isUnsupportedCaptureRouteError(err)) return;
      throw new VoiceProfilesUnavailableError(
        "/api/voice/first-run/profile/append",
        err,
      );
    }
  }

  /** Finalize the capture session and promote the entity to OWNER. */
  async finalizeOwnerCapture(
    sessionId: string,
    payload: { displayName: string },
  ): Promise<VoiceCaptureSubmitResult> {
    try {
      return await this.client.fetch<VoiceCaptureSubmitResult>(
        `/api/voice/first-run/profile/finalize?id=${encodeURIComponent(sessionId)}`,
        { method: "POST", body: JSON.stringify(payload) },
      );
    } catch (err) {
      if (isMissingEndpointError(err) || isUnsupportedCaptureRouteError(err))
        return fallbackOwnerSubmitResult(sessionId);
      throw new VoiceProfilesUnavailableError(
        "/api/voice/first-run/profile/finalize",
        err,
      );
    }
  }

  /**
   * Capture a family member's voice and create a bound non-OWNER entity.
   *
   * Calls `POST /v1/voice/first-run/family-member`. On 404 / 503 (encoder
   * not available) falls back gracefully so first-run is never blocked.
   */
  async captureFamilyMember(
    payload: FamilyMemberCapturePayload,
  ): Promise<FamilyMemberCaptureResult> {
    try {
      return await this.client.fetch<FamilyMemberCaptureResult>(
        "/v1/voice/first-run/family-member",
        {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
        },
      );
    } catch (err) {
      if (isMissingEndpointError(err)) {
        // Graceful fallback — encoder not live or route not registered yet.
        return {
          profileId: `family-stub-${Date.now().toString(36)}`,
          entityId: `family-entity-stub-${Date.now().toString(36)}`,
          displayName: payload.displayName,
          relationship: payload.relationship,
          relationshipTag: "family_of",
          ownerEntityId: payload.ownerEntityId ?? null,
        };
      }
      throw new VoiceProfilesUnavailableError(
        "/v1/voice/first-run/family-member",
        err,
      );
    }
  }

  /** Patch profile metadata (rename / relationship / retention). */
  async patch(id: string, patch: VoiceProfilePatch): Promise<void> {
    try {
      await this.client.fetch(`/api/voice/profiles/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    } catch (err) {
      if (isMissingEndpointError(err)) return;
      throw new VoiceProfilesUnavailableError(`/api/voice/profiles/${id}`, err);
    }
  }

  /** Merge `id` into `intoId`. */
  async merge(id: string, into: VoiceProfileMergeRequest): Promise<void> {
    try {
      await this.client.fetch(
        `/api/voice/profiles/${encodeURIComponent(id)}/merge`,
        { method: "POST", body: JSON.stringify(into) },
      );
    } catch (err) {
      if (isMissingEndpointError(err)) return;
      throw new VoiceProfilesUnavailableError(
        `/api/voice/profiles/${id}/merge`,
        err,
      );
    }
  }

  /** Split an auto-clustered profile by utterance ids. */
  async split(id: string, payload: VoiceProfileSplitRequest): Promise<void> {
    try {
      await this.client.fetch(
        `/api/voice/profiles/${encodeURIComponent(id)}/split`,
        { method: "POST", body: JSON.stringify(payload) },
      );
    } catch (err) {
      if (isMissingEndpointError(err)) return;
      throw new VoiceProfilesUnavailableError(
        `/api/voice/profiles/${id}/split`,
        err,
      );
    }
  }

  /** Delete a profile (OWNER cannot be deleted via UI). */
  async delete(id: string): Promise<void> {
    try {
      await this.client.fetch(`/api/voice/profiles/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (err) {
      if (isMissingEndpointError(err)) return;
      throw new VoiceProfilesUnavailableError(`/api/voice/profiles/${id}`, err);
    }
  }

  /** Bulk export (metadata only). Returns a signed URL on the server, or `null` for the fallback. */
  async exportAll(): Promise<{ downloadUrl: string | null }> {
    try {
      return await this.client.fetch<{ downloadUrl: string | null }>(
        "/api/voice/profiles/export",
        { method: "POST" },
      );
    } catch (err) {
      if (isMissingEndpointError(err)) return { downloadUrl: null };
      throw new VoiceProfilesUnavailableError(
        "/api/voice/profiles/export",
        err,
      );
    }
  }

  /** Delete all profiles. `includeOwner` is opt-in; default keeps OWNER. */
  async deleteAll(options?: { includeOwner?: boolean }): Promise<void> {
    const query = options?.includeOwner ? "?includeOwner=true" : "";
    try {
      await this.client.fetch(`/api/voice/profiles${query}`, {
        method: "DELETE",
      });
    } catch (err) {
      if (isMissingEndpointError(err)) return;
      throw new VoiceProfilesUnavailableError("/api/voice/profiles", err);
    }
  }
}

const OWNER_CAPTURE_FALLBACK_PROMPTS: VoiceCapturePrompt[] = [
  {
    id: "intro",
    text: "Hi, I'm setting up Eliza. Can you remember the sound of my voice?",
    targetSeconds: 5,
  },
  {
    id: "long",
    text:
      "The quick brown fox jumps over the lazy dog. " +
      "Pack my box with five dozen liquor jugs.",
    targetSeconds: 7,
  },
  {
    id: "natural",
    text:
      "Tell me about my schedule today, and let me know if anything urgent " +
      "comes up while we're talking.",
    targetSeconds: 6,
  },
];

function fallbackCaptureSession(sessionId?: string): VoiceCaptureSession {
  return {
    sessionId: sessionId ?? `local-${Date.now().toString(36)}`,
    prompts: OWNER_CAPTURE_FALLBACK_PROMPTS,
    expectedSeconds: OWNER_CAPTURE_FALLBACK_PROMPTS.reduce(
      (sum, prompt) => sum + prompt.targetSeconds,
      0,
    ),
  };
}

function fallbackOwnerSubmitResult(
  sessionId: string,
): VoiceCaptureSubmitResult {
  return {
    profileId: `owner-${sessionId}`,
    entityId: `owner-entity-${sessionId}`,
    isOwner: true,
  };
}

function normaliseCaptureSession(raw: unknown): VoiceCaptureSession {
  if (!raw || typeof raw !== "object") return fallbackCaptureSession();
  const r = raw as Record<string, unknown>;
  const sessionId =
    typeof r.sessionId === "string" && r.sessionId.length > 0
      ? r.sessionId
      : undefined;

  let prompts: VoiceCapturePrompt[] = [];
  const promptList = r.prompts;
  const scriptList = r.script;
  const hasPromptList = Array.isArray(promptList);
  const hasScriptList = Array.isArray(scriptList);
  if (hasPromptList) {
    prompts = promptList.map(normaliseCapturePrompt).filter(isCapturePrompt);
  }

  if (prompts.length === 0 && hasScriptList) {
    prompts = scriptList.map(normaliseScriptPrompt).filter(isCapturePrompt);
  }

  if (prompts.length === 0) {
    return fallbackCaptureSession();
  }

  const expectedSeconds =
    typeof r.expectedSeconds === "number" && r.expectedSeconds > 0
      ? r.expectedSeconds
      : prompts.reduce((sum, p) => sum + p.targetSeconds, 0);

  return {
    sessionId: sessionId ?? `local-${Date.now().toString(36)}`,
    prompts,
    expectedSeconds,
  };
}

function normaliseCapturePrompt(raw: unknown): VoiceCapturePrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.length > 0 ? r.id : null;
  const text = typeof r.text === "string" && r.text.length > 0 ? r.text : null;
  if (!id || !text) return null;
  return {
    id,
    text,
    targetSeconds:
      typeof r.targetSeconds === "number" && r.targetSeconds > 0
        ? r.targetSeconds
        : 5,
  };
}

function normaliseScriptPrompt(raw: unknown): VoiceCapturePrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.prompt !== "string") return null;
  return {
    id: r.id,
    text: r.prompt,
    targetSeconds:
      typeof r.expectedDurationMs === "number" && r.expectedDurationMs > 0
        ? Math.max(1, Math.round(r.expectedDurationMs / 1000))
        : 5,
  };
}

function isCapturePrompt(
  value: VoiceCapturePrompt | null,
): value is VoiceCapturePrompt {
  return value !== null;
}

function isProfile(value: VoiceProfile | null): value is VoiceProfile {
  return value !== null;
}

function normaliseProfile(raw: unknown): VoiceProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  if (!id) return null;
  return {
    id,
    entityId: typeof r.entityId === "string" ? r.entityId : null,
    displayName:
      typeof r.displayName === "string" && r.displayName.length > 0
        ? r.displayName
        : id,
    relationshipLabel:
      typeof r.relationshipLabel === "string" ? r.relationshipLabel : null,
    isOwner: r.isOwner === true,
    embeddingCount: typeof r.embeddingCount === "number" ? r.embeddingCount : 0,
    firstHeardAtMs: typeof r.firstHeardAtMs === "number" ? r.firstHeardAtMs : 0,
    lastHeardAtMs: typeof r.lastHeardAtMs === "number" ? r.lastHeardAtMs : 0,
    cohort: isCohort(r.cohort) ? r.cohort : "unknown",
    source: isSource(r.source) ? r.source : "auto-clustered",
    retentionDays: typeof r.retentionDays === "number" ? r.retentionDays : null,
    samplePreviewUri:
      typeof r.samplePreviewUri === "string" ? r.samplePreviewUri : null,
  };
}

function isCohort(value: unknown): value is VoiceProfileCohort {
  return (
    value === "owner" ||
    value === "family" ||
    value === "guest" ||
    value === "unknown"
  );
}

function isSource(value: unknown): value is VoiceProfileSource {
  return (
    value === "first-run" || value === "auto-clustered" || value === "manual"
  );
}

function isMissingEndpointError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const obj = err as { status?: unknown; kind?: unknown; message?: unknown };
  // Treat both 404 (route not registered) and the unwrapped network errors
  // as "endpoint not landed yet" — the adapter renders an empty state.
  if (
    obj.status === 404 ||
    obj.status === 405 ||
    obj.status === 501 ||
    obj.status === 503
  )
    return true;
  if (
    obj.kind === "http" &&
    (obj.status === 404 ||
      obj.status === 405 ||
      obj.status === 501 ||
      obj.status === 503)
  )
    return true;
  if (obj.kind === "network" || obj.kind === "timeout" || obj.kind === "parse")
    return true;
  if (
    typeof obj.message === "string" &&
    /(not\s*found|unavailable|connection\s*refused|fetch\s*failed|invalid\s*json|request\s*timed\s*out|api\s*not\s*available)/i.test(
      obj.message,
    )
  ) {
    return true;
  }
  return false;
}

function isUnsupportedCaptureRouteError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const obj = err as { status?: unknown; kind?: unknown; message?: unknown };
  if (obj.status !== 400 && !(obj.kind === "http" && obj.status === 400))
    return false;
  if (typeof obj.message !== "string") return true;
  return /(id query parameter|required|invalid pcm|invalid json|no embeddings captured|capture too short)/i.test(
    obj.message,
  );
}

/** Helper for callers that already hold an `ElizaClient` instance. */
export function createVoiceProfilesClient(
  client: VoiceProfilesClientLike,
): VoiceProfilesClient {
  return new VoiceProfilesClient(client);
}
