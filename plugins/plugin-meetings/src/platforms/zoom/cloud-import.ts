/**
 * Authenticated Zoom cloud import boundary. It reads meeting, roster,
 * recording, and VTT transcript resources with bounded guarded requests,
 * rehosts retained bytes in the canonical media store, and emits the shared
 * MeetingArtifact contract consumed by transcript persistence.
 */

import { createHash } from "node:crypto";
import { fetchWithSsrfGuard } from "@elizaos/core";
import {
  assertValidMeetingArtifact,
  MEETING_ARTIFACT_SCHEMA_VERSION,
  type MeetingArtifact,
  type MeetingArtifactMediaRef,
  type MeetingArtifactPlatformParticipant,
  type MeetingArtifactSourceStream,
  type MeetingArtifactTranscriptSpan,
} from "@elizaos/shared";
import { persistMeetingMedia } from "../../transcripts/meeting-transcript-writer.js";

const ZOOM_API_BASE = "https://api.zoom.us/v2";
const DEFAULT_JSON_LIMIT = 8 * 1024 * 1024;
const DEFAULT_FILE_LIMIT = 256 * 1024 * 1024;
const DEFAULT_TOTAL_LIMIT = 512 * 1024 * 1024;
const MAX_PARTICIPANT_PAGES = 100;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ZoomCloudImportErrorCode =
  | "invalid_request"
  | "revoked_access"
  | "permission_denied"
  | "meeting_not_found"
  | "expired_media_url"
  | "max_bytes"
  | "invalid_response"
  | "request_failed";

export class ZoomCloudImportError extends Error {
  constructor(
    readonly code: ZoomCloudImportErrorCode,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ZoomCloudImportError";
  }
}

export interface ZoomCloudImportInput {
  meetingId: string;
  accessToken: string;
  retainRecordings?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  fetchImpl?: FetchLike;
}

export interface ZoomCloudImportResult {
  artifact: MeetingArtifact;
  warnings: string[];
  requestIds: string[];
}

interface ZoomMeetingResponse {
  id?: string | number;
  uuid?: string;
  topic?: string;
  host_id?: string;
  host_email?: string;
  timezone?: string;
  start_time?: string;
  end_time?: string;
  duration?: number;
}

interface ZoomParticipantResponse {
  id?: string;
  user_id?: string;
  user_email?: string;
  name?: string;
  join_time?: string;
  leave_time?: string;
}

interface ZoomRecordingFileResponse {
  id?: string;
  file_type?: string;
  file_extension?: string;
  recording_type?: string;
  recording_start?: string;
  recording_end?: string;
  status?: string;
  download_url?: string;
}

interface ZoomRecordingsResponse extends ZoomMeetingResponse {
  recording_files?: ZoomRecordingFileResponse[];
}

interface DownloadedFile {
  source: ZoomRecordingFileResponse;
  bytes: Buffer;
  extension: string;
  mimeType: string;
  media: MeetingArtifactMediaRef;
}

interface VttCue {
  id: string;
  startMs: number;
  endMs: number;
  speakerLabel?: string;
  text: string;
}

export async function importZoomCloudMeeting(
  input: ZoomCloudImportInput,
): Promise<ZoomCloudImportResult> {
  const meetingId = input.meetingId.trim();
  const accessToken = input.accessToken.trim();
  if (!meetingId || !accessToken) {
    throw new ZoomCloudImportError(
      "invalid_request",
      "Zoom meetingId and accessToken are required.",
      400,
    );
  }
  const maxFileBytes = positiveLimit(
    input.maxFileBytes,
    DEFAULT_FILE_LIMIT,
    "maxFileBytes",
  );
  const maxTotalBytes = positiveLimit(
    input.maxTotalBytes,
    DEFAULT_TOTAL_LIMIT,
    "maxTotalBytes",
  );
  const encodedId = encodeZoomMeetingId(meetingId);
  const requestIds: string[] = [];
  const fetchOptions = { accessToken, fetchImpl: input.fetchImpl, requestIds };

  const meeting = await requestJson<ZoomMeetingResponse>(
    `${ZOOM_API_BASE}/past_meetings/${encodedId}`,
    fetchOptions,
  );
  const participants = await requestAllParticipants(encodedId, fetchOptions);
  const recordings = await requestJson<ZoomRecordingsResponse>(
    `${ZOOM_API_BASE}/meetings/${encodedId}/recordings`,
    fetchOptions,
  );
  const recordingFiles = providerRows<ZoomRecordingFileResponse>(
    recordings.recording_files,
    "recording_files",
  );
  const sourceFiles = recordingFiles.filter((file) =>
    shouldRetainFile(file, input.retainRecordings ?? true),
  );

  const pending: Array<Omit<DownloadedFile, "media">> = [];
  let totalBytes = 0;
  for (const file of sourceFiles) {
    if (!file.download_url) continue;
    const format = zoomFileFormat(file);
    if (!format) continue;
    const bytes = await requestBytes(file.download_url, {
      ...fetchOptions,
      maxBytes: Math.min(maxFileBytes, maxTotalBytes - totalBytes),
    });
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) {
      throw new ZoomCloudImportError(
        "max_bytes",
        `Zoom import exceeded maxTotalBytes ${maxTotalBytes}.`,
        413,
      );
    }
    pending.push({ source: file, bytes, ...format });
  }

  // Compute canonical refs before writing. Every remote read and artifact
  // validation must succeed before bytes become visible in the media store.
  const downloaded: DownloadedFile[] = pending.map((file) => {
    const checksum = createHash("sha256").update(file.bytes).digest("hex");
    return {
      ...file,
      media: {
        id: checksum,
        url: `/api/media/${checksum}.${file.extension}`,
        mimeType: file.mimeType,
        checksum,
        title: zoomFileTitle(file.source),
      },
    };
  });
  const warnings = importWarnings(recordingFiles, downloaded);
  let artifact: MeetingArtifact;
  try {
    artifact = buildZoomSharedMeetingArtifact({
      requestedMeetingId: meetingId,
      meeting: { ...meeting, ...recordings },
      participants,
      files: downloaded,
    });
  } catch (error) {
    // error-policy:J2 Provider shapes that cannot satisfy the shared artifact
    // contract are explicit invalid responses, never partially stored success.
    throw new ZoomCloudImportError(
      "invalid_response",
      "Zoom resources could not be normalized into a valid meeting artifact.",
      502,
      undefined,
      error,
    );
  }
  for (const file of downloaded) {
    persistMeetingMedia(file.bytes, file.extension);
  }
  return { artifact, warnings, requestIds: [...new Set(requestIds)] };
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ZoomCloudImportError(
      "invalid_request",
      `${field} must be a positive safe integer.`,
      400,
    );
  }
  return value;
}

function encodeZoomMeetingId(meetingId: string): string {
  const once = encodeURIComponent(meetingId);
  return meetingId.startsWith("/") || meetingId.includes("//")
    ? encodeURIComponent(once)
    : once;
}

async function requestAllParticipants(
  encodedId: string,
  options: {
    accessToken: string;
    fetchImpl?: FetchLike;
    requestIds: string[];
  },
): Promise<ZoomParticipantResponse[]> {
  const participants: ZoomParticipantResponse[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_PARTICIPANT_PAGES) {
      throw new ZoomCloudImportError(
        "invalid_response",
        `Zoom participants pagination exceeded ${MAX_PARTICIPANT_PAGES} pages.`,
        502,
      );
    }
    const url = new URL(
      `${ZOOM_API_BASE}/past_meetings/${encodedId}/participants`,
    );
    url.searchParams.set("page_size", "300");
    if (token) url.searchParams.set("next_page_token", token);
    const page = await requestJson<{
      participants?: ZoomParticipantResponse[];
      next_page_token?: string;
    }>(url.toString(), options);
    participants.push(
      ...providerRows<ZoomParticipantResponse>(
        page.participants,
        "participants",
      ),
    );
    token = page.next_page_token?.trim() || undefined;
    if (token && seenTokens.has(token)) {
      throw new ZoomCloudImportError(
        "invalid_response",
        "Zoom participants pagination repeated a page token.",
        502,
      );
    }
    if (token) seenTokens.add(token);
  } while (token);
  return participants;
}

function providerRows<T>(value: unknown, field: string): T[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw new ZoomCloudImportError(
      "invalid_response",
      `Zoom ${field} must be an array of objects.`,
      502,
    );
  }
  return value as T[];
}

async function requestJson<T>(
  url: string,
  options: {
    accessToken: string;
    fetchImpl?: FetchLike;
    requestIds: string[];
  },
): Promise<T> {
  const bytes = await guardedRequest(url, {
    ...options,
    maxBytes: DEFAULT_JSON_LIMIT,
    accept: "application/json",
  });
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    return parsed as T;
  } catch (error) {
    // error-policy:J2 Preserve the parse cause while rejecting the untrusted
    // provider response rather than manufacturing an empty success object.
    throw new ZoomCloudImportError(
      "invalid_response",
      "Zoom returned malformed JSON.",
      502,
      undefined,
      error,
    );
  }
}

async function requestBytes(
  url: string,
  options: {
    accessToken: string;
    fetchImpl?: FetchLike;
    requestIds: string[];
    maxBytes: number;
  },
): Promise<Buffer> {
  return guardedRequest(url, { ...options, accept: "*/*" });
}

async function guardedRequest(
  url: string,
  options: {
    accessToken: string;
    fetchImpl?: FetchLike;
    requestIds: string[];
    maxBytes: number;
    accept: string;
  },
): Promise<Buffer> {
  let guarded: Awaited<ReturnType<typeof fetchWithSsrfGuard>>;
  try {
    guarded = await fetchWithSsrfGuard({
      url,
      fetchImpl: options.fetchImpl,
      timeoutMs: 30_000,
      maxRedirects: 5,
      init: {
        headers: {
          Accept: options.accept,
          Authorization: `Bearer ${options.accessToken}`,
        },
      },
    });
  } catch (error) {
    // error-policy:J2 Provider/network context is added without exposing the
    // token-bearing request headers or URL query.
    throw new ZoomCloudImportError(
      "request_failed",
      "Zoom request failed before a response was received.",
      502,
      undefined,
      error,
    );
  }
  const { response, release } = guarded;
  try {
    const requestId =
      response.headers.get("x-zm-trackingid") ??
      response.headers.get("x-zoom-request-id");
    if (requestId) options.requestIds.push(requestId);
    if (!response.ok) {
      const snippet = await readErrorSnippet(response);
      throw zoomHttpError(response.status, snippet, requestId ?? undefined);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      throw new ZoomCloudImportError(
        "max_bytes",
        `Zoom response content length ${contentLength} exceeds limit ${options.maxBytes}.`,
        413,
        requestId ?? undefined,
      );
    }
    return await readBoundedBody(response, options.maxBytes);
  } finally {
    await release();
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await readZoomStreamChunk(reader);
      if (result.done) break;
      if (!result.value) {
        throw new ZoomCloudImportError(
          "invalid_response",
          "Zoom response stream returned a chunk without bytes.",
          502,
        );
      }
      const chunk = Buffer.from(result.value);
      total += chunk.length;
      if (total > maxBytes) {
        const quotaError = new ZoomCloudImportError(
          "max_bytes",
          `Zoom response exceeded limit ${maxBytes}.`,
          413,
        );
        try {
          await reader.cancel("Zoom response exceeded configured byte limit");
        } catch (cancelError) {
          throw new ZoomCloudImportError(
            quotaError.code,
            quotaError.message,
            quotaError.status,
            quotaError.requestId,
            cancelError,
          );
        }
        throw quotaError;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

async function readZoomStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ done: boolean; value?: Uint8Array }> {
  try {
    return await reader.read();
  } catch (error) {
    // error-policy:J2 A provider stream failure remains distinct from a valid
    // empty response and preserves the underlying transport cause.
    throw new ZoomCloudImportError(
      "request_failed",
      "Zoom response stream failed while being read.",
      502,
      undefined,
      error,
    );
  }
}

async function readErrorSnippet(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < 4_096) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = 4_096 - total;
      const chunk = Buffer.from(result.value).subarray(0, remaining);
      chunks.push(Buffer.from(chunk));
      total += chunk.length;
      if (chunk.length < result.value.length) {
        await reader.cancel("Zoom error body diagnostic limit reached");
        break;
      }
    }
    return Buffer.concat(chunks, total)
      .toString("utf8")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  } catch {
    // error-policy:J7 The HTTP status remains authoritative if optional
    // provider diagnostics cannot be read.
    return "";
  } finally {
    reader.releaseLock();
  }
}

function zoomHttpError(
  status: number,
  detail: string,
  requestId?: string,
): ZoomCloudImportError {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401) {
    return new ZoomCloudImportError(
      "revoked_access",
      `Zoom access token was rejected${suffix}`,
      status,
      requestId,
    );
  }
  if (status === 403) {
    return new ZoomCloudImportError(
      "permission_denied",
      `Zoom artifacts are not visible to this account${suffix}`,
      status,
      requestId,
    );
  }
  if (status === 404) {
    return new ZoomCloudImportError(
      "meeting_not_found",
      `Zoom meeting was not found${suffix}`,
      status,
      requestId,
    );
  }
  if (status === 410) {
    return new ZoomCloudImportError(
      "expired_media_url",
      `Zoom media URL expired${suffix}`,
      status,
      requestId,
    );
  }
  return new ZoomCloudImportError(
    "request_failed",
    `Zoom returned HTTP ${status}${suffix}`,
    status,
    requestId,
  );
}

function shouldRetainFile(
  file: ZoomRecordingFileResponse,
  retainRecordings: boolean,
): boolean {
  const format = zoomFileFormat(file);
  if (!format) return false;
  return format.mimeType === "text/vtt" || retainRecordings;
}

function zoomFileFormat(
  file: ZoomRecordingFileResponse,
): { extension: string; mimeType: string } | null {
  const value = (file.file_extension ?? file.file_type ?? "").toLowerCase();
  if (value === "vtt") return { extension: "vtt", mimeType: "text/vtt" };
  if (value === "m4a") return { extension: "m4a", mimeType: "audio/mp4" };
  if (value === "mp3") return { extension: "mp3", mimeType: "audio/mpeg" };
  if (value === "wav") return { extension: "wav", mimeType: "audio/wav" };
  if (value === "mp4") return { extension: "mp4", mimeType: "video/mp4" };
  return null;
}

function zoomFileTitle(file: ZoomRecordingFileResponse): string {
  return `${file.recording_type ?? "recording"}.${(
    file.file_extension ?? file.file_type ?? "bin"
  ).toLowerCase()}`;
}

function importWarnings(
  listed: readonly ZoomRecordingFileResponse[],
  downloaded: readonly DownloadedFile[],
): string[] {
  const warnings: string[] = [];
  if (!listed.some((file) => zoomFileFormat(file)?.mimeType === "text/vtt")) {
    warnings.push("transcript_unavailable");
  }
  for (const file of listed) {
    if (zoomFileFormat(file) && !file.download_url) {
      warnings.push(
        `expired_media_url:${file.id ?? file.recording_type ?? "unknown"}`,
      );
    }
  }
  if (!downloaded.some((file) => file.mimeType.startsWith("audio/"))) {
    warnings.push("audio_recording_unavailable");
  }
  return warnings;
}

function buildZoomSharedMeetingArtifact(input: {
  requestedMeetingId: string;
  meeting: ZoomMeetingResponse;
  participants: readonly ZoomParticipantResponse[];
  files: readonly DownloadedFile[];
}): MeetingArtifact {
  const nativeMeetingId = String(
    input.meeting.uuid ?? input.meeting.id ?? input.requestedMeetingId,
  );
  const platformParticipants = input.participants.map(mapParticipant);
  const participantByName = new Map(
    platformParticipants
      .filter((participant) => participant.displayName)
      .map((participant) => [
        participant.displayName?.toLowerCase(),
        participant,
      ]),
  );
  const sourceStreams: MeetingArtifactSourceStream[] = input.files.map(
    (file) => ({
      id: `zoom-stream:${file.source.id ?? file.media.id}`,
      kind: "recording",
      mediaRefId: file.media.id,
      label: file.source.recording_type,
    }),
  );
  const streamByMediaId = new Map(
    sourceStreams.map((stream) => [stream.mediaRefId, stream]),
  );
  const transcriptSpans: MeetingArtifactTranscriptSpan[] = [];
  for (const file of input.files.filter(
    (candidate) => candidate.mimeType === "text/vtt",
  )) {
    const stream = streamByMediaId.get(file.media.id);
    if (!stream) continue;
    for (const cue of parseWebVtt(file.bytes.toString("utf8"))) {
      const participant = cue.speakerLabel
        ? participantByName.get(cue.speakerLabel.toLowerCase())
        : undefined;
      const speakerId = cue.speakerLabel
        ? `zoom-speaker:${stableLabel(cue.speakerLabel)}`
        : undefined;
      transcriptSpans.push({
        id: `${stream.id}:${cue.id}`,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        words: [],
        speakerId,
        platformParticipantId: participant?.id,
        sourceStreamId: stream.id,
      });
    }
  }
  const speakerLabels = new Map<string, string>();
  for (const span of transcriptSpans) {
    if (!span.speakerId) continue;
    const cueLabel = span.platformParticipantId
      ? platformParticipants.find(
          (row) => row.id === span.platformParticipantId,
        )?.displayName
      : span.speakerId.replace(/^zoom-speaker:/, "").replace(/-/g, " ");
    speakerLabels.set(span.speakerId, cueLabel ?? span.speakerId);
  }
  const artifact: MeetingArtifact = {
    schemaVersion: MEETING_ARTIFACT_SCHEMA_VERSION,
    artifactId: `zoom-import:${nativeMeetingId}`,
    meeting: {
      id: nativeMeetingId,
      nativeMeetingId,
      platform: "zoom",
      captureMode: "cloud_agent_capture",
      title: input.meeting.topic,
      startedAt: input.meeting.start_time,
      endedAt: input.meeting.end_time,
      consent: { state: "unknown" },
      retentionPolicy: {
        retainAudio: input.files.some((file) =>
          file.mimeType.startsWith("audio/"),
        ),
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    media: input.files.map((file) => file.media),
    sourceStreams,
    platformParticipants,
    diarizedSpeakers: [...speakerLabels].map(([id, displayName]) => ({
      id,
      sourceStreamIds: [
        ...new Set(
          transcriptSpans
            .filter((span) => span.speakerId === id)
            .map((span) => span.sourceStreamId),
        ),
      ],
      platformParticipantIds: [
        ...new Set(
          transcriptSpans
            .filter((span) => span.speakerId === id)
            .map((span) => span.platformParticipantId)
            .filter((value): value is string => Boolean(value)),
        ),
      ],
      name: { displayName, provenance: "platform", confidence: 1 },
      status: "active",
    })),
    entityBindings: [],
    transcriptSpans,
    notes: [],
    actionItems: [],
    decisions: [],
    evidenceArtifacts: input.files.map((file) => ({
      id: `zoom-evidence:${file.source.id ?? file.media.id}`,
      kind: "media",
      mediaRefId: file.media.id,
      description: file.source.recording_type ?? file.media.title,
    })),
    provenance: {
      createdAt: new Date().toISOString(),
      generator: "@elizaos/plugin-meetings/zoom-cloud-import",
    },
  };
  assertValidMeetingArtifact(artifact);
  return artifact;
}

function mapParticipant(
  participant: ZoomParticipantResponse,
  index: number,
): MeetingArtifactPlatformParticipant {
  const id =
    participant.id ??
    participant.user_id ??
    participant.user_email ??
    `zoom-participant-${index + 1}`;
  return {
    id,
    displayName: participant.name,
    joinedAtMs: epochMs(participant.join_time),
    leftAtMs: epochMs(participant.leave_time),
  };
}

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseWebVtt(value: string): VttCue[] {
  const blocks = value
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\r?\n+/)
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith("WEBVTT"));
  const cues: VttCue[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;
    const timing = lines[timingIndex]?.split("-->");
    if (!timing?.[0] || !timing[1]) continue;
    const startMs = vttTimestampMs(timing[0]);
    const endMs = vttTimestampMs(timing[1].trim().split(/\s+/)[0] ?? "");
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const rawText = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!rawText) continue;
    const speaker = /^([^:]{1,120}):\s+(.+)$/.exec(rawText);
    cues.push({
      id: lines[timingIndex - 1]?.trim() || `cue-${cues.length + 1}`,
      startMs,
      endMs,
      speakerLabel: speaker?.[1]?.trim(),
      text: speaker?.[2]?.trim() ?? rawText,
    });
  }
  return cues;
}

function vttTimestampMs(value: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function stableLabel(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase()) || "unknown";
}
