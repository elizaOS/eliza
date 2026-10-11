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
 * Stable internal shape consumed by `VoiceProfileSection`. Mirrors R10 §5.1 —
 * keep wide-compatible fields here, narrow server-specific fields in the
 * adapter.
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

/**
 * Single failure context used by every adapter call so the UI can render a
 * stable empty state instead of a generic toast/spinner.
 */
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
  fetch<T>(path: string, init?: RequestInit): Promise<T>;
}

/**
 * Adapter facade — keep the public surface narrow so the UI doesn't bind
 * to optional fields the server might omit.
 */
export class VoiceProfilesClient {
  constructor(private readonly client: VoiceProfilesClientLike) {}

  /** List all known profiles. */
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
      throw new VoiceProfilesUnavailableError("/api/voice/profiles", err);
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
      throw new VoiceProfilesUnavailableError(`/api/voice/profiles/${id}`, err);
    }
  }

  /** Merge `id` into `intoId`. */
  async merge(
    id: string,
    into: VoiceProfileMergeRequest,
  ): Promise<VoiceProfile> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/merge`,
        { method: "POST", body: JSON.stringify(into) },
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
  ): Promise<{ original: VoiceProfile; split: VoiceProfile }> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/split`,
        { method: "POST", body: JSON.stringify(payload) },
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
  ): Promise<VoiceProfile> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/bind`,
        { method: "POST", body: JSON.stringify(payload) },
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
  async unbind(id: string): Promise<VoiceProfile> {
    try {
      const raw = await this.client.fetch<unknown>(
        `/api/voice/profiles/${encodeURIComponent(id)}/unbind`,
        { method: "POST" },
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
  async delete(id: string): Promise<void> {
    try {
      await this.client.fetch(`/api/voice/profiles/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (err) {
      throw new VoiceProfilesUnavailableError(`/api/voice/profiles/${id}`, err);
    }
  }

  /** Bulk export (metadata only). Returns a server-signed download URL. */
  async exportAll(): Promise<{ downloadUrl: string | null }> {
    try {
      return await this.client.fetch<{ downloadUrl: string | null }>(
        "/api/voice/profiles/export",
        { method: "POST" },
      );
    } catch (err) {
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
      throw new VoiceProfilesUnavailableError("/api/voice/profiles", err);
    }
  }
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
