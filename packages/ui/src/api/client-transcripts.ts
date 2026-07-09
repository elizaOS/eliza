/**
 * Transcript API client methods (#8789) — list / get / create / update /
 * delete plus permission grants over `/api/transcripts`. Declaration-merged
 * onto `ElizaClient` (the side-effect import in `client.ts` installs the
 * prototype methods), matching the other `client-*` domain modules.
 */

import type { ArtifactShareGrantMode } from "@elizaos/core";
import type {
  Transcript,
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

declare module "./client-base" {
  interface ElizaClient {
    listTranscripts(
      roomId?: string,
    ): Promise<{ transcripts: TranscriptSummary[] }>;
    getTranscript(id: string): Promise<{ transcript: Transcript }>;
    createTranscript(
      input: TranscriptCreateInput,
    ): Promise<{ transcript: Transcript }>;
    updateTranscript(
      id: string,
      input: TranscriptUpdateInput,
    ): Promise<{ transcript: Transcript }>;
    deleteTranscript(id: string): Promise<{ ok: boolean }>;
    shareTranscript(
      id: string,
      input: TranscriptShareInput,
    ): Promise<TranscriptShareResult>;
    revokeTranscriptShare(
      id: string,
      entityId: string,
    ): Promise<TranscriptRevokeShareResult>;
  }
}

ElizaClient.prototype.listTranscripts = async function (
  this: ElizaClient,
  roomId?: string,
) {
  const q = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
  return this.fetch(`/api/transcripts${q}`);
};

ElizaClient.prototype.getTranscript = async function (
  this: ElizaClient,
  id: string,
) {
  return this.fetch(`/api/transcripts/${encodeURIComponent(id)}`);
};

ElizaClient.prototype.createTranscript = async function (
  this: ElizaClient,
  input: TranscriptCreateInput,
) {
  return this.fetch("/api/transcripts", {
    method: "POST",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.updateTranscript = async function (
  this: ElizaClient,
  id: string,
  input: TranscriptUpdateInput,
) {
  return this.fetch(`/api/transcripts/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.deleteTranscript = async function (
  this: ElizaClient,
  id: string,
) {
  return this.fetch(`/api/transcripts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.shareTranscript = async function (
  this: ElizaClient,
  id: string,
  input: TranscriptShareInput,
) {
  return this.fetch(`/api/transcripts/${encodeURIComponent(id)}/share`, {
    method: "POST",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.revokeTranscriptShare = async function (
  this: ElizaClient,
  id: string,
  entityId: string,
) {
  return this.fetch(
    `/api/transcripts/${encodeURIComponent(id)}/share/${encodeURIComponent(
      entityId,
    )}`,
    { method: "DELETE" },
  );
};
