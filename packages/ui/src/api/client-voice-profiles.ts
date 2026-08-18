/**
 * Voice profile client.
 *
 * Adapter layer between the UI surfaces and the server-side speaker-id +
 * voice-profile endpoints served by `@elizaos/plugin-local-inference`. Ships
 * a stable internal `VoiceProfile` shape and normalises the server response
 * into it. Every call issues a real HTTP request and surfaces failures as a
 * `VoiceProfilesUnavailableError` — it never fabricates success or data.
 */

export type VoiceProfileCohort = "owner" | "family" | "guest" | "unknown";
export type VoiceProfileSource = "first-run" | "auto-clustered" | "manual";

export interface VoiceProfileSample {
  /** Stable sample id accepted by the split endpoint. */
  id: string;
  durationMs: number;
  recordedAt: string;
}

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
  /** Retained enrollment samples available for an explicit split operation. */
  samples: VoiceProfileSample[];
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
/** List GET — existing 10s REST budget, independent hop. */
export const VOICE_PROFILES_LIST_FETCH_TIMEOUT_MS = 10_000;
/** First-run start POST — existing 10s REST budget, independent hop. */
export const VOICE_PROFILES_START_FETCH_TIMEOUT_MS = 10_000;
/** First-run append POST — existing 10s REST budget, independent hop. */
export const VOICE_PROFILES_APPEND_FETCH_TIMEOUT_MS = 10_000;
/** First-run finalize POST — existing 10s REST budget, independent hop. */
export const VOICE_PROFILES_FINALIZE_FETCH_TIMEOUT_MS = 10_000;
/** First-run family-member POST — existing 10s REST budget, independent hop. */
export const VOICE_PROFILES_FAMILY_FETCH_TIMEOUT_MS = 10_000;
/** Profile mutation hops — existing 10s REST budget, independent per call. */
export const VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS = 10_000;

export class VoiceProfilesUnavailableError extends Error {
  constructor(
    readonly endpoint: string,
    readonly cause?: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message.trim() : "";
    super(
      detail
        ? `Voice profile request failed: ${detail}`
        : `Voice profiles endpoint unavailable: ${endpoint}`,
    );
    this.name = "VoiceProfilesUnavailableError";
  }
}

interface VoiceProfilesClientLike {
  fetch<T>(
    path: string,
    init?: RequestInit,
    options?: { timeoutMs?: number },
  ): Promise<T>;
}

/**
 * Adapter facade — keep the public surface narrow so the UI doesn't bind
 * to optional fields the server might omit.
 */
export class VoiceProfilesClient {
  constructor(private readonly client: VoiceProfilesClientLike) {}

  /** List all known profiles. */
  async list(
    timeoutMs: number = VOICE_PROFILES_LIST_FETCH_TIMEOUT_MS,
  ): Promise<VoiceProfile[]> {
    try {
      const raw = await this.client.fetch<{ profiles?: unknown[] } | unknown[]>(
        "/api/voice/profiles",
        undefined,
        { timeoutMs },
      );
      const items = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { profiles?: unknown[] })?.profiles)
          ? ((raw as { profiles?: unknown[] }).profiles ?? [])
          : [];
      return items.map(normaliseProfile).filter(isProfile);
    } catch (err) {
      throw new VoiceProfilesUnavailableError("/api/voice/profiles", err);
    }
  }

  /** Start first-run capture for the OWNER profile. */
  async startOwnerCapture(
    timeoutMs: number = VOICE_PROFILES_START_FETCH_TIMEOUT_MS,
  ): Promise<VoiceCaptureSession> {
    try {
      const raw = await this.client.fetch<unknown>(
        "/api/voice/first-run/profile/start",
        { method: "POST" },
        { timeoutMs },
      );
      return normaliseCaptureSession(raw);
    } catch (err) {
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
    timeoutMs: number = VOICE_PROFILES_APPEND_FETCH_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await this.client.fetch(
        `/api/voice/first-run/profile/append?id=${encodeURIComponent(sessionId)}`,
        { method: "POST", body: JSON.stringify(payload) },
        { timeoutMs },
      );
    } catch (err) {
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
    timeoutMs: number = VOICE_PROFILES_FINALIZE_FETCH_TIMEOUT_MS,
  ): Promise<VoiceCaptureSubmitResult> {
    try {
      return await this.client.fetch<VoiceCaptureSubmitResult>(
        `/api/voice/first-run/profile/finalize?id=${encodeURIComponent(sessionId)}`,
        { method: "POST", body: JSON.stringify(payload) },
        { timeoutMs },
      );
    } catch (err) {
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
    timeoutMs: number = VOICE_PROFILES_FAMILY_FETCH_TIMEOUT_MS,
  ): Promise<FamilyMemberCaptureResult> {
    try {
      return await this.client.fetch<FamilyMemberCaptureResult>(
        "/v1/voice/first-run/family-member",
        {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
        },
        { timeoutMs },
      );
    } catch (err) {
      throw new VoiceProfilesUnavailableError(
        "/v1/voice/first-run/family-member",
        err,
      );
    }
  }

  /** Patch profile metadata (rename / relationship / retention). */
  async patch(
    id: string,
    patch: VoiceProfilePatch,
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await this.client.fetch(
        `/api/voice/profiles/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
        { timeoutMs },
      );
    } catch (err) {
      throw new VoiceProfilesUnavailableError(`/api/voice/profiles/${id}`, err);
    }
  }

  /** Merge `id` into `intoId`. */
  async merge(
    id: string,
    into: VoiceProfileMergeRequest,
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<VoiceProfile> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/merge`,
        { method: "POST", body: JSON.stringify(into) },
        { timeoutMs },
      );
      const profile = normaliseProfile(raw);
      if (!profile)
        throw new Error("Voice profile merge returned an invalid profile.");
      return profile;
    } catch (err) {
      throw new VoiceProfilesUnavailableError(
        `/api/voice/profiles/${id}/merge`,
        err,
      );
    }
  }

  /** Split an auto-clustered profile by utterance ids. */
  async split(
    id: string,
    payload: VoiceProfileSplitRequest,
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<{ original: VoiceProfile; split: VoiceProfile }> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/split`,
        { method: "POST", body: JSON.stringify(payload) },
        { timeoutMs },
      );
      if (!raw || typeof raw !== "object") {
        throw new Error("Voice profile split returned an invalid response.");
      }
      const response = raw as Record<string, unknown>;
      const original = normaliseProfile(response.original);
      const split = normaliseProfile(response.split);
      if (!original || !split) {
        throw new Error("Voice profile split returned invalid profiles.");
      }
      return { original, split };
    } catch (err) {
      throw new VoiceProfilesUnavailableError(
        `/api/voice/profiles/${id}/split`,
        err,
      );
    }
  }

  /** Bind a recognized profile to an existing entity. */
  async bind(
    id: string,
    payload: { entityId: string; label?: string },
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<VoiceProfile> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/bind`,
        { method: "POST", body: JSON.stringify(payload) },
        { timeoutMs },
      );
      const profile = normaliseProfile(raw);
      if (!profile)
        throw new Error("Voice profile bind returned an invalid profile.");
      return profile;
    } catch (err) {
      throw new VoiceProfilesUnavailableError(
        `/api/voice/profiles/${id}/bind`,
        err,
      );
    }
  }

  /** Remove a non-owner profile's entity binding. */
  async unbind(
    id: string,
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<VoiceProfile> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/unbind`,
        { method: "POST" },
        { timeoutMs },
      );
      const profile = normaliseProfile(raw);
      if (!profile)
        throw new Error("Voice profile unbind returned an invalid profile.");
      return profile;
    } catch (err) {
      throw new VoiceProfilesUnavailableError(
        `/api/voice/profiles/${id}/unbind`,
        err,
      );
    }
  }

  /** Delete a profile (OWNER cannot be deleted via UI). */
  async delete(
    id: string,
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await this.client.fetch(
        `/api/voice/profiles/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
        { timeoutMs },
      );
    } catch (err) {
      throw new VoiceProfilesUnavailableError(`/api/voice/profiles/${id}`, err);
    }
  }

  /** Bulk export (metadata only). Returns a server-signed download URL. */
  async exportAll(
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<{ downloadUrl: string | null }> {
    try {
      return await this.client.fetch<{ downloadUrl: string | null }>(
        "/api/voice/profiles/export",
        { method: "POST" },
        { timeoutMs },
      );
    } catch (err) {
      throw new VoiceProfilesUnavailableError(
        "/api/voice/profiles/export",
        err,
      );
    }
  }

  /** Delete all profiles. `includeOwner` is opt-in; default keeps OWNER. */
  async deleteAll(
    options?: { includeOwner?: boolean },
    timeoutMs: number = VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  ): Promise<void> {
    const query = options?.includeOwner ? "?includeOwner=true" : "";
    try {
      await this.client.fetch(
        `/api/voice/profiles${query}`,
        {
          method: "DELETE",
        },
        { timeoutMs },
      );
    } catch (err) {
      throw new VoiceProfilesUnavailableError("/api/voice/profiles", err);
    }
  }
}

function normaliseCaptureSession(raw: unknown): VoiceCaptureSession {
  if (!raw || typeof raw !== "object") {
    throw new Error("Voice capture session response was not an object.");
  }
  const r = raw as Record<string, unknown>;
  const sessionId =
    typeof r.sessionId === "string" && r.sessionId.length > 0
      ? r.sessionId
      : null;
  if (!sessionId) {
    throw new Error("Voice capture session response is missing a sessionId.");
  }

  let prompts: VoiceCapturePrompt[] = [];
  const promptList = r.prompts;
  const scriptList = r.script;
  if (Array.isArray(promptList)) {
    prompts = promptList.map(normaliseCapturePrompt).filter(isCapturePrompt);
  }

  if (prompts.length === 0 && Array.isArray(scriptList)) {
    prompts = scriptList.map(normaliseScriptPrompt).filter(isCapturePrompt);
  }

  if (prompts.length === 0) {
    throw new Error("Voice capture session response contained no prompts.");
  }

  const expectedSeconds =
    typeof r.expectedSeconds === "number" && r.expectedSeconds > 0
      ? r.expectedSeconds
      : prompts.reduce((sum, p) => sum + p.targetSeconds, 0);

  return {
    sessionId,
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
    samples: Array.isArray(r.samples)
      ? r.samples.map(normaliseSample).filter(isSample)
      : [],
  };
}

function normaliseSample(raw: unknown): VoiceProfileSample | null {
  if (!raw || typeof raw !== "object") return null;
  const sample = raw as Record<string, unknown>;
  if (typeof sample.id !== "string" || sample.id.length === 0) return null;
  return {
    id: sample.id,
    durationMs:
      typeof sample.durationMs === "number" && sample.durationMs >= 0
        ? sample.durationMs
        : 0,
    recordedAt: typeof sample.recordedAt === "string" ? sample.recordedAt : "",
  };
}

function isSample(
  value: VoiceProfileSample | null,
): value is VoiceProfileSample {
  return value !== null;
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

/** Helper for callers that already hold an `ElizaClient` instance. */
export function createVoiceProfilesClient(
  client: VoiceProfilesClientLike,
): VoiceProfilesClient {
  return new VoiceProfilesClient(client);
}
