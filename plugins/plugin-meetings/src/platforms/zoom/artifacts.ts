/**
 * Pure Zoom artifact normalization for cloud imports and bot/raw-data capture
 * fixtures. This module deliberately has no Zoom SDK/API dependency so saved
 * response-shaped objects can be regression-tested without credentials.
 */

export type ZoomCanonicalStreamKind =
  | "zoom_cloud_transcript"
  | "zoom_cloud_recording"
  | "zoom_bot_participant_audio"
  | "zoom_bot_mixed_audio"
  | "zoom_bot_raw_data"
  | "zoom_bot_screen_video";

export type ZoomTranscriptSource =
  | "zoom_cloud_transcript"
  | "zoom_live_capture";

export type ZoomSourceLoss =
  | "per_participant_audio_unavailable"
  | "participant_identity_unavailable"
  | "mixed_audio_only"
  | "muted_participant"
  | "network_gap"
  | "recording_disabled";

export type ZoomCapturePath =
  | "cloud_recording_import"
  | "meeting_sdk_raw_data"
  | "bot_web_client"
  | "bot_free_desktop";

export type ZoomLiveCaptureOutcome =
  | "captured"
  | "waiting_room_timeout"
  | "denied_entry"
  | "host_removed_bot"
  | "recording_disabled"
  | "transcript_unavailable"
  | "network_loss"
  | "host_ended_meeting";

export type ZoomMissingArtifactReason =
  | "transcript_unavailable"
  | "transcript_delayed"
  | "recording_unavailable"
  | "recording_disabled"
  | "revoked_access"
  | "permission_denied"
  | "meeting_not_found"
  | "expired_media_url"
  | "waiting_room_timeout"
  | "denied_entry"
  | "host_removed_bot"
  | "muted_participants"
  | "network_loss"
  | "host_ended_meeting"
  | "per_participant_audio_unavailable";

export interface ZoomCloudMeeting {
  id: string;
  uuid?: string;
  topic?: string;
  hostId?: string;
  hostEmail?: string;
  timezone?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
}

export interface ZoomCloudParticipant {
  id: string;
  zoomParticipantId?: string;
  userId?: string;
  userGuid?: string;
  displayName: string;
  email?: string;
  joinTime?: string;
  leaveTime?: string;
  muted?: boolean;
}

export interface ZoomCloudRecordingFile {
  id: string;
  meetingId?: string;
  recordingType?: string;
  fileType?: string;
  fileExtension?: string;
  status?: string;
  downloadUrl?: string;
  playUrl?: string;
  recordingStart?: string;
  recordingEnd?: string;
}

export interface ZoomCloudTranscriptEntry {
  id?: string;
  sourceFileId?: string;
  speakerName?: string;
  /** Native Zoom participant/user id, when the transcript has one. */
  speakerId?: string;
  /** Diarizer-local speaker id; preserved separately from Zoom ids. */
  diarizedSpeakerId?: string;
  text: string;
  startTime?: string;
  endTime?: string;
  startOffsetMs?: number;
  endOffsetMs?: number;
  languageCode?: string;
}

export interface ZoomLiveCaptureStreamInput {
  id: string;
  kind: "participant_audio" | "mixed_audio" | "raw_data" | "screen_video";
  uri?: string;
  participantId?: string;
  startedAt?: string;
  endedAt?: string;
  sampleRateHz?: number;
  channels?: number;
  sourceLoss?: ZoomSourceLoss[];
}

export interface ZoomLiveCaptureArtifact {
  id: string;
  capturePath: Exclude<ZoomCapturePath, "cloud_recording_import">;
  outcome: ZoomLiveCaptureOutcome;
  startedAt?: string;
  endedAt?: string;
  streams: readonly ZoomLiveCaptureStreamInput[];
  transcriptSpans?: readonly ZoomCloudTranscriptEntry[];
}

export interface ZoomGeneratedNoteInput {
  id?: string;
  kind: "summary" | "key_point" | "action_item";
  text: string;
  assignee?: string;
  dueDate?: string;
  priority?: "low" | "medium" | "high";
}

export interface ZoomQualityMetricsInput {
  participantMappingAccuracy?: number;
  cloudTranscriptWer?: number;
  cloudTranscriptCer?: number;
  perParticipantDer?: number;
  mixedCaptureDer?: number;
  cpWer?: number;
  captureStartLatencyMs?: number;
  streamDropoutRate?: number;
  failureClassificationAccuracy?: number;
}

export interface ZoomCanonicalStream {
  id: string;
  kind: ZoomCanonicalStreamKind;
  capturePath: ZoomCapturePath;
  artifactId?: string;
  uri?: string;
  participantId?: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  sampleRateHz?: number;
  channels?: number;
  sourceLoss: ZoomSourceLoss[];
}

export interface ZoomCanonicalParticipant {
  id: string;
  displayName: string;
  zoomParticipantId?: string;
  zoomUserId?: string;
  userGuid?: string;
  email?: string;
  joinedAt?: string;
  leftAt?: string;
  muted?: boolean;
}

export interface ZoomCanonicalTranscriptSpan {
  id: string;
  streamId: string;
  source: ZoomTranscriptSource;
  text: string;
  participantId?: string;
  speakerLabel?: string;
  diarizedSpeakerId?: string;
  startedAt?: string;
  endedAt?: string;
  startOffsetMs?: number;
  endOffsetMs?: number;
  languageCode?: string;
  provenance: {
    zoomSpeakerId?: string;
    diarizedSpeakerId?: string;
    sourceFileId?: string;
    captureId?: string;
  };
}

export interface ZoomCanonicalGeneratedNote {
  id: string;
  kind: ZoomGeneratedNoteInput["kind"];
  text: string;
  sourceSpanIds: string[];
  assignee?: string;
  dueDate?: string;
  priority?: ZoomGeneratedNoteInput["priority"];
}

export interface ZoomMissingArtifact {
  artifactType:
    | "meeting"
    | "transcript"
    | "recording"
    | "live_capture"
    | "participant_audio";
  reason: ZoomMissingArtifactReason;
  message: string;
  sourceName?: string;
}

export interface ZoomCanonicalWarning {
  code:
    | "participant_reference_missing"
    | "participant_id_missing"
    | "transcript_entry_empty"
    | "mixed_audio_source_loss"
    | "muted_participant"
    | "network_loss"
    | "host_ended_meeting"
    | "recording_disabled"
    | "expired_media_url";
  message: string;
  sourceName?: string;
}

export interface ZoomCanonicalArtifact {
  schemaVersion: "elizaos.meeting_artifact.v1";
  source: "zoom";
  meeting: {
    id: string;
    uuid?: string;
    topic?: string;
    hostId?: string;
    hostEmail?: string;
    timezone?: string;
    startedAt?: string;
    endedAt?: string;
    durationMinutes: number;
  };
  streams: ZoomCanonicalStream[];
  participants: ZoomCanonicalParticipant[];
  transcriptSpans: ZoomCanonicalTranscriptSpan[];
  generatedNotes: ZoomCanonicalGeneratedNote[];
  recordings: ZoomCloudRecordingFile[];
  warnings: ZoomCanonicalWarning[];
  missingArtifacts: ZoomMissingArtifact[];
  metrics: ZoomQualityMetricsInput & {
    transcriptWordCount: number;
    participantCount: number;
    transcriptSpanCount: number;
    recordingCount: number;
    streamCount: number;
    sourceLossCount: number;
    missingArtifactCount: number;
    warningCount: number;
  };
}

export interface ZoomCanonicalArtifactInput {
  meeting: ZoomCloudMeeting;
  participants: readonly ZoomCloudParticipant[];
  recordingFiles: readonly ZoomCloudRecordingFile[];
  transcriptFiles?: readonly ZoomCloudRecordingFile[];
  transcriptEntries: readonly ZoomCloudTranscriptEntry[];
  liveCapture?: ZoomLiveCaptureArtifact;
  generatedNotes?: readonly ZoomGeneratedNoteInput[];
  qualityMetrics?: ZoomQualityMetricsInput;
  recordingDisabled?: boolean;
}

export function buildZoomCanonicalArtifact(
  input: ZoomCanonicalArtifactInput,
): ZoomCanonicalArtifact {
  const participantIndex = indexZoomParticipants(input.participants);
  const transcriptFiles = canonicalTranscriptFiles(input);
  const recordingFiles = input.recordingFiles.filter(
    (file) => !isTranscriptFile(file),
  );
  const cloudTranscriptStreams = transcriptFiles.map((file) =>
    canonicalCloudTranscriptStream(file),
  );
  const cloudRecordingStreams = recordingFiles.map((file) =>
    canonicalCloudRecordingStream(file),
  );
  const liveStreams = canonicalLiveStreams(input.liveCapture);
  const streams = [
    ...cloudTranscriptStreams,
    ...cloudRecordingStreams,
    ...liveStreams,
  ];
  const transcriptSpans = [
    ...input.transcriptEntries.map((entry, index) =>
      canonicalCloudTranscriptSpan(
        entry,
        index,
        transcriptFiles,
        participantIndex,
      ),
    ),
    ...canonicalLiveTranscriptSpans(input.liveCapture, participantIndex),
  ];
  const warnings = canonicalWarnings(input, transcriptSpans, streams);
  const missingArtifacts = canonicalMissingArtifacts(
    input,
    transcriptFiles,
    recordingFiles,
  );
  const generatedNotes = canonicalGeneratedNotes(
    input.generatedNotes ?? [],
    transcriptSpans,
  );

  return {
    schemaVersion: "elizaos.meeting_artifact.v1",
    source: "zoom",
    meeting: {
      id: input.meeting.id,
      uuid: input.meeting.uuid,
      topic: input.meeting.topic,
      hostId: input.meeting.hostId,
      hostEmail: input.meeting.hostEmail,
      timezone: input.meeting.timezone,
      startedAt: input.meeting.startTime,
      endedAt: input.meeting.endTime,
      durationMinutes: zoomDurationMinutes(input.meeting),
    },
    streams,
    participants: input.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      zoomParticipantId: participant.zoomParticipantId,
      zoomUserId: participant.userId,
      userGuid: participant.userGuid,
      email: participant.email,
      joinedAt: participant.joinTime,
      leftAt: participant.leaveTime,
      muted: participant.muted,
    })),
    transcriptSpans,
    generatedNotes,
    recordings: recordingFiles,
    warnings,
    missingArtifacts,
    metrics: {
      ...input.qualityMetrics,
      transcriptWordCount: transcriptSpans.reduce(
        (count, span) => count + wordCount(span.text),
        0,
      ),
      participantCount: input.participants.length,
      transcriptSpanCount: transcriptSpans.length,
      recordingCount: recordingFiles.length,
      streamCount: streams.length,
      sourceLossCount: streams.reduce(
        (count, stream) => count + stream.sourceLoss.length,
        0,
      ),
      missingArtifactCount: missingArtifacts.length,
      warningCount: warnings.length,
    },
  };
}

export function classifyZoomImportError(
  error: unknown,
): ZoomMissingArtifact | null {
  const status = errorStatus(error);
  const message = errorMessage(error);
  const normalized = message.toLowerCase();

  if (
    status === 401 ||
    normalized.includes("invalid_grant") ||
    normalized.includes("revoked")
  ) {
    return {
      artifactType: "meeting",
      reason: "revoked_access",
      message: message || "Zoom OAuth access was revoked.",
    };
  }
  if (status === 403) {
    return {
      artifactType: "meeting",
      reason: "permission_denied",
      message: message || "Zoom artifacts are not visible to this account.",
    };
  }
  if (status === 404) {
    return {
      artifactType: "meeting",
      reason: "meeting_not_found",
      message: message || "Zoom meeting was not found.",
    };
  }
  if (status === 410 || normalized.includes("expired")) {
    return {
      artifactType: "recording",
      reason: "expired_media_url",
      message: message || "Zoom media URL has expired.",
    };
  }
  if (normalized.includes("waiting room")) {
    return {
      artifactType: "live_capture",
      reason: "waiting_room_timeout",
      message: message || "Zoom bot was not admitted from the waiting room.",
    };
  }
  if (normalized.includes("denied") || normalized.includes("rejected")) {
    return {
      artifactType: "live_capture",
      reason: "denied_entry",
      message: message || "Zoom host denied bot entry.",
    };
  }
  if (normalized.includes("removed")) {
    return {
      artifactType: "live_capture",
      reason: "host_removed_bot",
      message: message || "Zoom host removed the bot.",
    };
  }
  if (normalized.includes("muted")) {
    return {
      artifactType: "participant_audio",
      reason: "muted_participants",
      message: message || "Zoom participant audio was muted.",
    };
  }
  if (normalized.includes("recording disabled")) {
    return {
      artifactType: "recording",
      reason: "recording_disabled",
      message: message || "Zoom recording was disabled.",
    };
  }
  if (normalized.includes("transcript unavailable")) {
    return {
      artifactType: "transcript",
      reason: "transcript_unavailable",
      message: message || "Zoom transcript was unavailable.",
    };
  }
  if (normalized.includes("network")) {
    return {
      artifactType: "live_capture",
      reason: "network_loss",
      message: message || "Zoom capture lost network connectivity.",
    };
  }
  if (
    normalized.includes("host ended") ||
    normalized.includes("ended by host")
  ) {
    return {
      artifactType: "live_capture",
      reason: "host_ended_meeting",
      message: message || "Zoom host ended the meeting.",
    };
  }

  return null;
}

function indexZoomParticipants(
  participants: readonly ZoomCloudParticipant[],
): ReadonlyMap<string, ZoomCloudParticipant> {
  const index = new Map<string, ZoomCloudParticipant>();
  for (const participant of participants) {
    const keys = [
      participant.id,
      participant.zoomParticipantId,
      participant.userId,
      participant.userGuid,
      participant.email,
      participant.displayName,
    ];
    for (const key of keys) {
      if (key) index.set(normalizeKey(key), participant);
    }
  }
  return index;
}

function canonicalTranscriptFiles(
  input: ZoomCanonicalArtifactInput,
): ZoomCloudRecordingFile[] {
  if (input.transcriptFiles?.length) return [...input.transcriptFiles];
  return input.recordingFiles.filter((file) => isTranscriptFile(file));
}

function canonicalCloudTranscriptStream(
  file: ZoomCloudRecordingFile,
): ZoomCanonicalStream {
  return {
    id: cloudTranscriptStreamId(file.id),
    kind: "zoom_cloud_transcript",
    capturePath: "cloud_recording_import",
    artifactId: file.id,
    uri: file.downloadUrl ?? file.playUrl,
    startedAt: file.recordingStart,
    endedAt: file.recordingEnd,
    status: file.status,
    sourceLoss: [],
  };
}

function canonicalCloudRecordingStream(
  file: ZoomCloudRecordingFile,
): ZoomCanonicalStream {
  return {
    id: `zoom-cloud-recording:${file.id}`,
    kind: "zoom_cloud_recording",
    capturePath: "cloud_recording_import",
    artifactId: file.id,
    uri: file.downloadUrl ?? file.playUrl,
    startedAt: file.recordingStart,
    endedAt: file.recordingEnd,
    status: file.status,
    sourceLoss:
      file.status === "recording_disabled" ? ["recording_disabled"] : [],
  };
}

function canonicalLiveStreams(
  capture: ZoomLiveCaptureArtifact | undefined,
): ZoomCanonicalStream[] {
  if (!capture) return [];
  return capture.streams.map((stream) => {
    const kind = liveStreamKind(stream);
    const sourceLoss = new Set(stream.sourceLoss ?? []);
    if (stream.kind === "mixed_audio") {
      sourceLoss.add("mixed_audio_only");
      sourceLoss.add("per_participant_audio_unavailable");
    }
    if (stream.kind === "participant_audio" && !stream.participantId) {
      sourceLoss.add("participant_identity_unavailable");
    }
    return {
      id: liveStreamId(capture.id, stream),
      kind,
      capturePath: capture.capturePath,
      artifactId: capture.id,
      uri: stream.uri,
      participantId: stream.participantId,
      startedAt: stream.startedAt ?? capture.startedAt,
      endedAt: stream.endedAt ?? capture.endedAt,
      sampleRateHz: stream.sampleRateHz,
      channels: stream.channels,
      sourceLoss: [...sourceLoss],
    };
  });
}

function canonicalCloudTranscriptSpan(
  entry: ZoomCloudTranscriptEntry,
  index: number,
  transcriptFiles: readonly ZoomCloudRecordingFile[],
  participantIndex: ReadonlyMap<string, ZoomCloudParticipant>,
): ZoomCanonicalTranscriptSpan {
  const participant = resolveParticipant(entry, participantIndex);
  const sourceFileId = entry.sourceFileId ?? transcriptFiles[0]?.id;
  return {
    id: entry.id ?? `zoom-cloud-transcript-entry-${index + 1}`,
    streamId: sourceFileId
      ? cloudTranscriptStreamId(sourceFileId)
      : "zoom-cloud-transcript",
    source: "zoom_cloud_transcript",
    text: entry.text,
    participantId: participant?.id,
    speakerLabel: participant?.displayName ?? entry.speakerName,
    diarizedSpeakerId: entry.diarizedSpeakerId,
    startedAt: entry.startTime,
    endedAt: entry.endTime,
    startOffsetMs: entry.startOffsetMs,
    endOffsetMs: entry.endOffsetMs,
    languageCode: entry.languageCode,
    provenance: {
      zoomSpeakerId: entry.speakerId,
      diarizedSpeakerId: entry.diarizedSpeakerId,
      sourceFileId,
    },
  };
}

function canonicalLiveTranscriptSpans(
  capture: ZoomLiveCaptureArtifact | undefined,
  participantIndex: ReadonlyMap<string, ZoomCloudParticipant>,
): ZoomCanonicalTranscriptSpan[] {
  if (!capture?.transcriptSpans?.length) return [];
  const mixedStream = capture.streams.find(
    (stream) => stream.kind === "mixed_audio",
  );
  const firstStream = capture.streams[0];

  return capture.transcriptSpans.map((span, index) => {
    const participant = resolveParticipant(span, participantIndex);
    const participantStream = participant
      ? capture.streams.find(
          (stream) =>
            stream.kind === "participant_audio" &&
            stream.participantId === participant.id,
        )
      : undefined;
    const stream = participantStream ?? mixedStream ?? firstStream;
    return {
      id: span.id ?? `zoom-live-transcript-entry-${index + 1}`,
      streamId: stream
        ? liveStreamId(capture.id, stream)
        : `zoom-live:${capture.id}`,
      source: "zoom_live_capture",
      text: span.text,
      participantId: participant?.id,
      speakerLabel: participant?.displayName ?? span.speakerName,
      diarizedSpeakerId: span.diarizedSpeakerId,
      startedAt: span.startTime,
      endedAt: span.endTime,
      startOffsetMs: span.startOffsetMs,
      endOffsetMs: span.endOffsetMs,
      languageCode: span.languageCode,
      provenance: {
        zoomSpeakerId: span.speakerId,
        diarizedSpeakerId: span.diarizedSpeakerId,
        sourceFileId: span.sourceFileId,
        captureId: capture.id,
      },
    };
  });
}

function canonicalWarnings(
  input: ZoomCanonicalArtifactInput,
  spans: readonly ZoomCanonicalTranscriptSpan[],
  streams: readonly ZoomCanonicalStream[],
): ZoomCanonicalWarning[] {
  const warnings: ZoomCanonicalWarning[] = [];

  for (const participant of input.participants) {
    if (
      !participant.zoomParticipantId &&
      !participant.userId &&
      !participant.userGuid
    ) {
      warnings.push({
        code: "participant_id_missing",
        message:
          "Zoom participant has a display name but no native participant/user id.",
        sourceName: participant.id,
      });
    }
    if (participant.muted) {
      warnings.push({
        code: "muted_participant",
        message:
          "Zoom participant was muted during at least one capture window.",
        sourceName: participant.id,
      });
    }
  }

  for (const span of spans) {
    if (!span.text.trim()) {
      warnings.push({
        code: "transcript_entry_empty",
        message: "Zoom transcript entry contained no text.",
        sourceName: span.id,
      });
    }
    if (
      (span.provenance.zoomSpeakerId || span.speakerLabel) &&
      !span.participantId
    ) {
      warnings.push({
        code: "participant_reference_missing",
        message:
          "Zoom transcript entry referenced a speaker that was not present in the participant roster.",
        sourceName: span.id,
      });
    }
  }

  for (const stream of streams) {
    if (
      stream.sourceLoss.includes("mixed_audio_only") ||
      stream.sourceLoss.includes("per_participant_audio_unavailable")
    ) {
      warnings.push({
        code: "mixed_audio_source_loss",
        message:
          "Zoom capture contains mixed audio; per-participant stream identity was unavailable.",
        sourceName: stream.id,
      });
    }
    if (stream.sourceLoss.includes("network_gap")) {
      warnings.push({
        code: "network_loss",
        message: "Zoom capture stream reported a network gap.",
        sourceName: stream.id,
      });
    }
    if (stream.sourceLoss.includes("recording_disabled")) {
      warnings.push({
        code: "recording_disabled",
        message:
          "Zoom recording stream reports recording-disabled source loss.",
        sourceName: stream.id,
      });
    }
  }

  for (const file of [
    ...input.recordingFiles,
    ...(input.transcriptFiles ?? []),
  ]) {
    if (file.id && !file.downloadUrl && !file.playUrl) {
      warnings.push({
        code: "expired_media_url",
        message:
          "Zoom media file exists but no download or playback URL was visible.",
        sourceName: file.id,
      });
    }
  }

  if (input.liveCapture?.outcome === "network_loss") {
    warnings.push({
      code: "network_loss",
      message: "Zoom live capture ended after network loss.",
      sourceName: input.liveCapture.id,
    });
  }
  if (input.liveCapture?.outcome === "host_ended_meeting") {
    warnings.push({
      code: "host_ended_meeting",
      message: "Zoom live capture ended because the host ended the meeting.",
      sourceName: input.liveCapture.id,
    });
  }

  return warnings;
}

function canonicalMissingArtifacts(
  input: ZoomCanonicalArtifactInput,
  transcriptFiles: readonly ZoomCloudRecordingFile[],
  recordingFiles: readonly ZoomCloudRecordingFile[],
): ZoomMissingArtifact[] {
  const missing: ZoomMissingArtifact[] = [];

  if (transcriptFiles.length === 0 && input.transcriptEntries.length === 0) {
    missing.push({
      artifactType: "transcript",
      reason: input.meeting.endTime
        ? "transcript_unavailable"
        : "transcript_delayed",
      message: input.meeting.endTime
        ? "No Zoom cloud transcript file or transcript entries were available."
        : "Zoom cloud transcript is not available yet for the active meeting.",
    });
  }

  if (recordingFiles.length === 0) {
    missing.push({
      artifactType: "recording",
      reason: input.recordingDisabled
        ? "recording_disabled"
        : "recording_unavailable",
      message: input.recordingDisabled
        ? "Zoom cloud recording was disabled for this meeting."
        : "No Zoom cloud recording files were available for this meeting.",
    });
  }

  for (const file of [...recordingFiles, ...transcriptFiles]) {
    if (file.id && !file.downloadUrl && !file.playUrl) {
      missing.push({
        artifactType: isTranscriptFile(file) ? "transcript" : "recording",
        reason: "expired_media_url",
        message:
          "Zoom media file exists but no download or playback URL was available.",
        sourceName: file.id,
      });
    }
  }

  if (input.liveCapture) {
    if (input.liveCapture.outcome !== "captured") {
      missing.push(
        liveCaptureMissingArtifact(
          input.liveCapture,
          input.liveCapture.outcome,
        ),
      );
    }
    const hasParticipantStream = input.liveCapture.streams.some(
      (stream) => stream.kind === "participant_audio",
    );
    const hasMixedAudio = input.liveCapture.streams.some(
      (stream) => stream.kind === "mixed_audio",
    );
    if (hasMixedAudio && !hasParticipantStream) {
      missing.push({
        artifactType: "participant_audio",
        reason: "per_participant_audio_unavailable",
        message:
          "Zoom capture only provided mixed audio; per-participant audio was unavailable.",
        sourceName: input.liveCapture.id,
      });
    }
  }

  return missing;
}

function liveCaptureMissingArtifact(
  capture: ZoomLiveCaptureArtifact,
  reason: Exclude<ZoomLiveCaptureOutcome, "captured">,
): ZoomMissingArtifact {
  const artifactType =
    reason === "recording_disabled"
      ? "recording"
      : reason === "transcript_unavailable"
        ? "transcript"
        : "live_capture";
  return {
    artifactType,
    reason,
    message: `Zoom live capture ended with outcome: ${reason}.`,
    sourceName: capture.id,
  };
}

function canonicalGeneratedNotes(
  notes: readonly ZoomGeneratedNoteInput[],
  spans: readonly ZoomCanonicalTranscriptSpan[],
): ZoomCanonicalGeneratedNote[] {
  return notes.map((note, index) => ({
    id: note.id ?? `${note.kind}-${index + 1}`,
    kind: note.kind,
    text: note.text,
    sourceSpanIds: matchingSpanIds(spans, note.text),
    assignee: note.assignee,
    dueDate: note.dueDate,
    priority: note.priority,
  }));
}

function matchingSpanIds(
  spans: readonly ZoomCanonicalTranscriptSpan[],
  text: string,
): string[] {
  const normalizedText = normalizeText(text);
  return spans
    .filter((span) => {
      const normalizedSpan = normalizeText(span.text);
      return (
        normalizedSpan &&
        (normalizedText.includes(normalizedSpan) ||
          normalizedSpan.includes(normalizedText))
      );
    })
    .map((span) => span.id);
}

function resolveParticipant(
  entry: ZoomCloudTranscriptEntry,
  participantIndex: ReadonlyMap<string, ZoomCloudParticipant>,
): ZoomCloudParticipant | undefined {
  const keys = [entry.speakerId, entry.speakerName];
  for (const key of keys) {
    if (!key) continue;
    const participant = participantIndex.get(normalizeKey(key));
    if (participant) return participant;
  }
  return undefined;
}

function liveStreamKind(
  stream: ZoomLiveCaptureStreamInput,
): ZoomCanonicalStreamKind {
  if (stream.kind === "participant_audio") return "zoom_bot_participant_audio";
  if (stream.kind === "raw_data") return "zoom_bot_raw_data";
  if (stream.kind === "screen_video") return "zoom_bot_screen_video";
  return "zoom_bot_mixed_audio";
}

function liveStreamId(
  captureId: string,
  stream: ZoomLiveCaptureStreamInput,
): string {
  return `zoom-live:${captureId}:${stream.id}`;
}

function cloudTranscriptStreamId(fileId: string): string {
  return `zoom-cloud-transcript:${fileId}`;
}

function isTranscriptFile(file: ZoomCloudRecordingFile): boolean {
  const fileType = file.fileType?.toLowerCase();
  const extension = file.fileExtension?.toLowerCase();
  const recordingType = file.recordingType?.toLowerCase();
  return (
    fileType === "transcript" ||
    fileType === "vtt" ||
    extension === "vtt" ||
    extension === "txt" ||
    recordingType === "audio_transcript"
  );
}

function zoomDurationMinutes(meeting: ZoomCloudMeeting): number {
  if (typeof meeting.durationMinutes === "number")
    return meeting.durationMinutes;
  if (!meeting.startTime || !meeting.endTime) return 0;
  const startedAt = Date.parse(meeting.startTime);
  const endedAt = Date.parse(meeting.endTime);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, Math.round((endedAt - startedAt) / 60_000));
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeKey(key: string): string {
  return normalizeText(key);
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const code = numberField(error, "code") ?? numberField(error, "status");
  if (code !== null) return code;
  const response = error.response;
  if (isRecord(response)) return numberField(response, "status");
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const message = stringField(error, "message");
    if (message) return message;
    const response = error.response;
    if (isRecord(response)) {
      const responseMessage = stringField(response, "message");
      if (responseMessage) return responseMessage;
    }
  }
  return "";
}

function numberField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
