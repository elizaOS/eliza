/**
 * Transcript API client methods (#8789) — list / get / create / update /
 * delete plus permission grants over `/api/transcripts`. Declaration-merged
 * onto `ElizaClient` (the side-effect import in `client.ts` installs the
 * prototype methods), matching the other `client-*` domain modules.
 */

import type { ArtifactShareGrantMode } from "@elizaos/core";
import type {
  Transcript,
  TranscriptCaptureSharingState,
  TranscriptScope,
  TranscriptSegment,
  TranscriptSource,
  TranscriptSummary,
} from "@elizaos/shared/transcripts";
import { ElizaClient } from "./client-base";

/** Body the recording pipeline POSTs to create a transcript record. The
 *  world/room/entity ids are optional — the server derives them from the agent
 *  context when the shell client doesn't supply them. */
export interface TranscriptCreateInput {
  worldId?: string;
  roomId?: string;
  entityId?: string;
  title?: string;
  source?: TranscriptSource;
  scope?: TranscriptScope;
  segments: TranscriptSegment[];
  audioUrl?: string;
  audioContentType?: string;
  /** Base64 WAV bytes — the server persists them to the media store and sets
   *  audioUrl. The shell sends this instead of audioUrl (it can't write files). */
  audioBase64?: string;
  createdAt?: number;
}

/** Body for a user edit to a transcript (title and/or replacement segments). */
export interface TranscriptUpdateInput {
  title?: string;
  segments?: TranscriptSegment[];
}

export interface TranscriptShareInput {
  entityId: string;
  mode: ArtifactShareGrantMode;
}

export interface TranscriptShareResult {
  ok: boolean;
  transcriptId: string;
  entityId: string;
  mode: ArtifactShareGrantMode;
  variantId?: string;
}

export interface TranscriptRevokeShareResult {
  ok: boolean;
  transcriptId: string;
  entityId: string;
}

export interface TranscriptPrivacyUpdateInput {
  sharing: Partial<TranscriptCaptureSharingState>;
}

/** List GET — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_LIST_FETCH_TIMEOUT_MS = 10_000;
/** Get GET — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_GET_FETCH_TIMEOUT_MS = 10_000;
/** Create POST — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_CREATE_FETCH_TIMEOUT_MS = 10_000;
/** Update PUT — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_UPDATE_FETCH_TIMEOUT_MS = 10_000;
/** Delete DELETE — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_DELETE_FETCH_TIMEOUT_MS = 10_000;
/** Share POST — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_SHARE_FETCH_TIMEOUT_MS = 10_000;
/** Revoke-share DELETE — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_REVOKE_SHARE_FETCH_TIMEOUT_MS = 10_000;
/** Privacy PATCH — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_PRIVACY_FETCH_TIMEOUT_MS = 10_000;
/** Source-audio DELETE — existing 10s REST budget, independent hop. */
export const TRANSCRIPTS_SOURCE_AUDIO_FETCH_TIMEOUT_MS = 10_000;

declare module "./client-base" {
  interface ElizaClient {
    listTranscripts(
      roomId?: string,
      timeoutMs?: number,
    ): Promise<{ transcripts: TranscriptSummary[] }>;
    getTranscript(
      id: string,
      timeoutMs?: number,
    ): Promise<{ transcript: Transcript }>;
    createTranscript(
      input: TranscriptCreateInput,
      timeoutMs?: number,
    ): Promise<{ transcript: Transcript }>;
    updateTranscript(
      id: string,
      input: TranscriptUpdateInput,
      timeoutMs?: number,
    ): Promise<{ transcript: Transcript }>;
    deleteTranscript(
      id: string,
      timeoutMs?: number,
    ): Promise<{ ok: boolean }>;
    shareTranscript(
      id: string,
      input: TranscriptShareInput,
      timeoutMs?: number,
    ): Promise<TranscriptShareResult>;
    revokeTranscriptShare(
      id: string,
      entityId: string,
      timeoutMs?: number,
    ): Promise<TranscriptRevokeShareResult>;
    updateTranscriptPrivacy(
      id: string,
      input: TranscriptPrivacyUpdateInput,
      timeoutMs?: number,
    ): Promise<{ transcript: Transcript }>;
    deleteTranscriptSourceAudio(
      id: string,
      timeoutMs?: number,
    ): Promise<{ deleted: boolean; transcript: Transcript }>;
  }
}

ElizaClient.prototype.listTranscripts = async function (
  this: ElizaClient,
  roomId?: string,
  timeoutMs: number = TRANSCRIPTS_LIST_FETCH_TIMEOUT_MS,
) {
  const q = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
  return this.fetch(`/api/transcripts${q}`, undefined, { timeoutMs });
};

ElizaClient.prototype.getTranscript = async function (
  this: ElizaClient,
  id: string,
  timeoutMs: number = TRANSCRIPTS_GET_FETCH_TIMEOUT_MS,
) {
  return this.fetch(`/api/transcripts/${encodeURIComponent(id)}`, undefined, {
    timeoutMs,
  });
};

ElizaClient.prototype.createTranscript = async function (
  this: ElizaClient,
  input: TranscriptCreateInput,
  timeoutMs: number = TRANSCRIPTS_CREATE_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    "/api/transcripts",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { timeoutMs },
  );
};

ElizaClient.prototype.updateTranscript = async function (
  this: ElizaClient,
  id: string,
  input: TranscriptUpdateInput,
  timeoutMs: number = TRANSCRIPTS_UPDATE_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/transcripts/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
    { timeoutMs },
  );
};

ElizaClient.prototype.deleteTranscript = async function (
  this: ElizaClient,
  id: string,
  timeoutMs: number = TRANSCRIPTS_DELETE_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/transcripts/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
    { timeoutMs },
  );
};

ElizaClient.prototype.shareTranscript = async function (
  this: ElizaClient,
  id: string,
  input: TranscriptShareInput,
  timeoutMs: number = TRANSCRIPTS_SHARE_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/transcripts/${encodeURIComponent(id)}/share`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { timeoutMs },
  );
};

ElizaClient.prototype.revokeTranscriptShare = async function (
  this: ElizaClient,
  id: string,
  entityId: string,
  timeoutMs: number = TRANSCRIPTS_REVOKE_SHARE_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/transcripts/${encodeURIComponent(id)}/share/${encodeURIComponent(
      entityId,
    )}`,
    { method: "DELETE" },
    { timeoutMs },
  );
};

ElizaClient.prototype.updateTranscriptPrivacy = async function (
  this: ElizaClient,
  id: string,
  input: TranscriptPrivacyUpdateInput,
  timeoutMs: number = TRANSCRIPTS_PRIVACY_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/transcripts/${encodeURIComponent(id)}/privacy`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
    { timeoutMs },
  );
};

ElizaClient.prototype.deleteTranscriptSourceAudio = async function (
  this: ElizaClient,
  id: string,
  timeoutMs: number = TRANSCRIPTS_SOURCE_AUDIO_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/transcripts/${encodeURIComponent(id)}/source-audio`,
    {
      method: "DELETE",
    },
    { timeoutMs },
  );
};
