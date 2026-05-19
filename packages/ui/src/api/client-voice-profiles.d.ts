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
export type VoiceProfileSource = "onboarding" | "auto-clustered" | "manual";
/**
 * Stable internal shape consumed by `VoiceProfileSection` and the onboarding
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
/** Capture step description supplied by I2 during onboarding (R10 §3.2 step 5). */
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
export declare class VoiceProfilesUnavailableError extends Error {
    readonly endpoint: string;
    readonly cause?: unknown | undefined;
    constructor(endpoint: string, cause?: unknown | undefined);
}
interface VoiceProfilesClientLike {
    fetch<T>(path: string, init?: RequestInit): Promise<T>;
}
/**
 * Adapter facade — keep the public surface narrow so the UI doesn't bind
 * to optional fields the server might omit.
 */
export declare class VoiceProfilesClient {
    private readonly client;
    constructor(client: VoiceProfilesClientLike);
    /** List all known profiles. Returns `[]` when the endpoint isn't available. */
    list(): Promise<VoiceProfile[]>;
    /** Start onboarding capture for the OWNER profile. */
    startOwnerCapture(): Promise<VoiceCaptureSession>;
    /** Append a captured audio chunk to an in-progress onboarding session. */
    appendOwnerCapture(sessionId: string, payload: {
        promptId: string;
        audioBase64: string;
        durationMs: number;
    }): Promise<void>;
    /** Finalize the capture session and promote the entity to OWNER. */
    finalizeOwnerCapture(sessionId: string, payload: {
        displayName: string;
    }): Promise<VoiceCaptureSubmitResult>;
    /**
     * Capture a family member's voice and create a bound non-OWNER entity.
     *
     * Calls `POST /v1/voice/onboarding/family-member`. On 404 / 503 (encoder
     * not available) falls back gracefully so onboarding is never blocked.
     */
    captureFamilyMember(payload: FamilyMemberCapturePayload): Promise<FamilyMemberCaptureResult>;
    /** Patch profile metadata (rename / relationship / retention). */
    patch(id: string, patch: VoiceProfilePatch): Promise<void>;
    /** Merge `id` into `intoId`. */
    merge(id: string, into: VoiceProfileMergeRequest): Promise<void>;
    /** Split an auto-clustered profile by utterance ids. */
    split(id: string, payload: VoiceProfileSplitRequest): Promise<void>;
    /** Delete a profile (OWNER cannot be deleted via UI). */
    delete(id: string): Promise<void>;
    /** Bulk export (metadata only). Returns a signed URL on the server, or `null` for the fallback. */
    exportAll(): Promise<{
        downloadUrl: string | null;
    }>;
    /** Delete all profiles. `includeOwner` is opt-in; default keeps OWNER. */
    deleteAll(options?: {
        includeOwner?: boolean;
    }): Promise<void>;
}
/** Helper for callers that already hold an `ElizaClient` instance. */
export declare function createVoiceProfilesClient(client: VoiceProfilesClientLike): VoiceProfilesClient;
export {};
//# sourceMappingURL=client-voice-profiles.d.ts.map