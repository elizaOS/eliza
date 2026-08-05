/**
 * `GoogleMeetClient` — Meet space management and conference-artifact reads
 * behind the workspace service: create/get/end spaces, and list participants,
 * transcripts, and recordings for a conference record. `generateReport`
 * assembles those artifacts into a structured `GoogleMeetReport`.
 * `GOOGLE_MEET_API_SURFACE` records the capability each method requires.
 */
import type { meet_v2 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GoogleAccountRef,
  GoogleMeetAccessType,
  GoogleMeetCanonicalArtifact,
  GoogleMeetCanonicalArtifactInput,
  GoogleMeetCanonicalStream,
  GoogleMeetCanonicalTranscriptSpan,
  GoogleMeetConferenceRecord,
  GoogleMeetConferenceRecordInput,
  GoogleMeetCreateMeetingInput,
  GoogleMeetGenerateReportInput,
  GoogleMeetMeeting,
  GoogleMeetMissingArtifact,
  GoogleMeetParticipant,
  GoogleMeetParticipantSession,
  GoogleMeetParticipantSessionInput,
  GoogleMeetRecording,
  GoogleMeetRecordingInput,
  GoogleMeetReport,
  GoogleMeetSpace,
  GoogleMeetTranscript,
  GoogleMeetTranscriptArtifact,
  GoogleMeetTranscriptInput,
} from "./types.js";
import { GoogleMeetStatus } from "./types.js";

export const GOOGLE_MEET_API_SURFACE = [
  { method: "createMeeting", capabilities: ["meet.create"] },
  { method: "getMeeting", capabilities: ["meet.read"] },
  { method: "getMeetingSpace", capabilities: ["meet.read"] },
  { method: "getConferenceRecord", capabilities: ["meet.read"] },
  { method: "listMeetingParticipants", capabilities: ["meet.read"] },
  { method: "listMeetingParticipantSessions", capabilities: ["meet.read"] },
  { method: "listMeetingTranscripts", capabilities: ["meet.read"] },
  { method: "getMeetingTranscript", capabilities: ["meet.read"] },
  { method: "listMeetingRecordings", capabilities: ["meet.read"] },
  { method: "getMeetingRecordingUrl", capabilities: ["meet.read"] },
  { method: "endMeeting", capabilities: ["meet.create"] },
  { method: "generateReport", capabilities: ["meet.read"] },
] as const;

export class GoogleMeetClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async createMeeting(params: GoogleMeetCreateMeetingInput): Promise<GoogleMeetMeeting> {
    const meet = await this.clientFactory.meet(params, ["meet.create"], "meet.createMeeting");
    const response = await meet.spaces.create({
      requestBody: {
        config: params.accessType ? { accessType: params.accessType } : undefined,
      },
    });

    return {
      ...mapSpace(response.data, params.title),
      title: params.title,
      startTime: new Date().toISOString(),
      participants: [],
      transcripts: [],
      status: response.data.activeConference ? GoogleMeetStatus.ACTIVE : GoogleMeetStatus.WAITING,
    };
  }

  async getMeeting(params: GoogleAccountRef & { meetingId: string }): Promise<GoogleMeetMeeting> {
    const space = await this.getMeetingSpace(params);
    return {
      ...space,
      participants: [],
      transcripts: [],
      status: space.activeConferenceRecord ? GoogleMeetStatus.ACTIVE : GoogleMeetStatus.WAITING,
    };
  }

  async getMeetingSpace(
    params: GoogleAccountRef & { meetingId: string }
  ): Promise<GoogleMeetSpace> {
    const meet = await this.clientFactory.meet(params, ["meet.read"], "meet.getMeetingSpace");
    const response = await meet.spaces.get({
      name: normalizeSpaceName(params.meetingId),
    });

    return mapSpace(response.data);
  }

  async getConferenceRecord(
    params: GoogleMeetConferenceRecordInput
  ): Promise<GoogleMeetConferenceRecord> {
    const meet = await this.clientFactory.meet(params, ["meet.read"], "meet.getConferenceRecord");
    const response = await meet.conferenceRecords.get({
      name: params.conferenceRecordName,
    });

    return mapConferenceRecord(response.data);
  }

  async listMeetingParticipants(
    params: GoogleMeetConferenceRecordInput & { limit?: number }
  ): Promise<GoogleMeetParticipant[]> {
    const meet = await this.clientFactory.meet(
      params,
      ["meet.read"],
      "meet.listMeetingParticipants"
    );
    const participants: GoogleMeetParticipant[] = [];
    let pageToken: string | undefined;

    do {
      const response = await meet.conferenceRecords.participants.list({
        parent: params.conferenceRecordName,
        pageSize: Math.min(params.limit ?? 100, 100),
        pageToken,
      });
      participants.push(...(response.data.participants ?? []).map(mapParticipant));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken && (!params.limit || participants.length < params.limit));

    return params.limit ? participants.slice(0, params.limit) : participants;
  }

  async listMeetingParticipantSessions(
    params: GoogleMeetParticipantSessionInput & { limit?: number }
  ): Promise<GoogleMeetParticipantSession[]> {
    const meet = await this.clientFactory.meet(
      params,
      ["meet.read"],
      "meet.listMeetingParticipantSessions"
    );
    const sessions: GoogleMeetParticipantSession[] = [];
    let pageToken: string | undefined;

    do {
      const response = await meet.conferenceRecords.participants.participantSessions.list({
        parent: params.participantName,
        pageSize: Math.min(params.limit ?? 100, 250),
        pageToken,
      });
      sessions.push(
        ...(response.data.participantSessions ?? []).map((session) =>
          mapParticipantSession(session, params.participantName)
        )
      );
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken && (!params.limit || sessions.length < params.limit));

    return params.limit ? sessions.slice(0, params.limit) : sessions;
  }

  async listMeetingTranscripts(
    params: GoogleMeetConferenceRecordInput
  ): Promise<GoogleMeetTranscriptArtifact[]> {
    const meet = await this.clientFactory.meet(
      params,
      ["meet.read"],
      "meet.listMeetingTranscripts"
    );
    const transcripts: GoogleMeetTranscriptArtifact[] = [];
    let pageToken: string | undefined;

    do {
      const response = await meet.conferenceRecords.transcripts.list({
        parent: params.conferenceRecordName,
        pageSize: 100,
        pageToken,
      });
      transcripts.push(...(response.data.transcripts ?? []).map(mapTranscriptArtifact));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return transcripts;
  }

  async getMeetingTranscript(params: GoogleMeetTranscriptInput): Promise<GoogleMeetTranscript[]> {
    const meet = await this.clientFactory.meet(params, ["meet.read"], "meet.getMeetingTranscript");
    const transcriptEntries: GoogleMeetTranscript[] = [];
    let pageToken: string | undefined;

    do {
      const response = await meet.conferenceRecords.transcripts.entries.list({
        parent: params.transcriptName,
        pageSize: 100,
        pageToken,
      });
      transcriptEntries.push(...(response.data.transcriptEntries ?? []).map(mapTranscriptEntry));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return transcriptEntries;
  }

  async listMeetingRecordings(
    params: GoogleMeetConferenceRecordInput
  ): Promise<GoogleMeetRecording[]> {
    const meet = await this.clientFactory.meet(params, ["meet.read"], "meet.listMeetingRecordings");
    const recordings: GoogleMeetRecording[] = [];
    let pageToken: string | undefined;

    do {
      const response = await meet.conferenceRecords.recordings.list({
        parent: params.conferenceRecordName,
        pageSize: 100,
        pageToken,
      });
      recordings.push(...(response.data.recordings ?? []).map(mapRecording));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return recordings;
  }

  async getMeetingRecordingUrl(params: GoogleMeetRecordingInput): Promise<string | null> {
    const meet = await this.clientFactory.meet(
      params,
      ["meet.read"],
      "meet.getMeetingRecordingUrl"
    );
    const response = await meet.conferenceRecords.recordings.get({
      name: params.recordingName,
    });

    return response.data.driveDestination?.exportUri ?? null;
  }

  async endMeeting(params: GoogleAccountRef & { spaceName: string }): Promise<void> {
    const meet = await this.clientFactory.meet(params, ["meet.create"], "meet.endMeeting");
    await meet.spaces.endActiveConference({
      name: normalizeSpaceName(params.spaceName),
      requestBody: {},
    });
  }

  async generateReport(params: GoogleMeetGenerateReportInput): Promise<GoogleMeetReport> {
    const conferenceRecordName = normalizeConferenceRecordName(params);
    const conference = await this.getConferenceRecord({
      accountId: params.accountId,
      conferenceRecordName,
    });
    const participants = await this.listMeetingParticipants({
      accountId: params.accountId,
      conferenceRecordName,
    });
    const participantSessions = await this.collectParticipantSessions(params, participants);
    const transcriptArtifacts = await this.collectTranscriptArtifacts(params, conferenceRecordName);
    const transcriptEntries = await this.collectTranscriptEntries(params, transcriptArtifacts);
    const summary = summarizeTranscript(transcriptEntries);
    const recordings =
      params.includeRecordings === false
        ? []
        : await this.listMeetingRecordings({
            accountId: params.accountId,
            conferenceRecordName,
          });
    const canonicalArtifact = buildGoogleMeetCanonicalArtifact({
      meetingId: params.meetingId ?? conferenceRecordName,
      conferenceRecordName,
      conference,
      participants,
      participantSessions,
      transcriptArtifacts,
      transcriptEntries,
      recordings,
      summary: params.includeSummary === false ? "" : summary.summary,
      keyPoints: params.includeSummary === false ? [] : summary.keyPoints,
      actionItems: params.includeActionItems === false ? [] : summary.actionItems,
      googleDocsTranscriptText: params.googleDocsTranscriptText,
      botFreeCapture: params.botFreeCapture,
    });

    return {
      meetingId: params.meetingId ?? conferenceRecordName,
      conferenceRecordName,
      title: `Google Meet Report - ${conferenceRecordName}`,
      date: conference.startTime,
      durationMinutes: durationMinutes(conference),
      participants,
      summary: params.includeSummary === false ? "" : summary.summary,
      keyPoints: params.includeSummary === false ? [] : summary.keyPoints,
      actionItems: params.includeActionItems === false ? [] : summary.actionItems,
      fullTranscript: params.includeTranscript === false ? [] : transcriptEntries,
      recordings,
      participantSessions,
      canonicalArtifact,
    };
  }

  private async collectParticipantSessions(
    params: GoogleMeetGenerateReportInput,
    participants: readonly GoogleMeetParticipant[]
  ): Promise<GoogleMeetParticipantSession[]> {
    const sessionGroups = await Promise.all(
      participants
        .map((participant) => participant.id || participant.name)
        .filter(Boolean)
        .map((participantName) =>
          this.listMeetingParticipantSessions({
            accountId: params.accountId,
            participantName,
          })
        )
    );

    return sessionGroups.flat();
  }

  private async collectTranscriptArtifacts(
    params: GoogleMeetGenerateReportInput,
    conferenceRecordName: string
  ): Promise<GoogleMeetTranscriptArtifact[]> {
    if (
      params.includeSummary === false &&
      params.includeActionItems === false &&
      params.includeTranscript === false
    ) {
      return [];
    }

    if (params.transcriptName) {
      return [{ id: params.transcriptName, name: params.transcriptName }];
    }

    return this.listMeetingTranscripts({
      accountId: params.accountId,
      conferenceRecordName,
    });
  }

  private async collectTranscriptEntries(
    params: GoogleMeetGenerateReportInput,
    transcriptArtifacts: readonly GoogleMeetTranscriptArtifact[]
  ): Promise<GoogleMeetTranscript[]> {
    const transcriptNames = transcriptArtifacts
      .map((transcript) => transcript.name)
      .filter(Boolean);

    const transcriptGroups = await Promise.all(
      transcriptNames.map((transcriptName) =>
        this.getMeetingTranscript({ accountId: params.accountId, transcriptName })
      )
    );

    return transcriptGroups.flat();
  }
}

function mapSpace(space: meet_v2.Schema$Space, title?: string): GoogleMeetSpace {
  const meetingCode = space.meetingCode ?? undefined;
  const spaceName = space.name ?? "";

  return {
    id: spaceName,
    spaceName,
    meetingCode,
    meetingUri: space.meetingUri ?? (meetingCode ? `https://meet.google.com/${meetingCode}` : ""),
    title,
    accessType: toMeetAccessType(space.config?.accessType),
    activeConferenceRecord: space.activeConference?.conferenceRecord ?? undefined,
  };
}

function mapConferenceRecord(
  conference: meet_v2.Schema$ConferenceRecord
): GoogleMeetConferenceRecord {
  return {
    id: conference.name ?? "",
    name: conference.name ?? "",
    spaceName: conference.space ?? undefined,
    startTime: conference.startTime ?? undefined,
    endTime: conference.endTime ?? undefined,
    expireTime: conference.expireTime ?? undefined,
  };
}

function mapParticipant(participant: meet_v2.Schema$Participant): GoogleMeetParticipant {
  const display = participantDisplay(participant);

  return {
    id: participant.name ?? "",
    name: display.name,
    displayName: display.name,
    joinTime: participant.earliestStartTime ?? undefined,
    leaveTime: participant.latestEndTime ?? undefined,
    isActive: !participant.latestEndTime,
    userType: display.userType,
  };
}

function mapParticipantSession(
  session: meet_v2.Schema$ParticipantSession,
  participantName: string
): GoogleMeetParticipantSession {
  const sessionName = session.name ?? "";

  return {
    id: sessionName,
    name: sessionName,
    participantId: participantName,
    participantName,
    startTime: session.startTime ?? undefined,
    endTime: session.endTime ?? undefined,
    isActive: !session.endTime,
  };
}

function mapTranscriptArtifact(
  transcript: meet_v2.Schema$Transcript
): GoogleMeetTranscriptArtifact {
  return {
    id: transcript.name ?? "",
    name: transcript.name ?? "",
    documentId: transcript.docsDestination?.document ?? undefined,
    documentUri: transcript.docsDestination?.exportUri ?? undefined,
    startTime: transcript.startTime ?? undefined,
    endTime: transcript.endTime ?? undefined,
    state: transcript.state ?? undefined,
  };
}

function mapTranscriptEntry(entry: meet_v2.Schema$TranscriptEntry): GoogleMeetTranscript {
  return {
    id: entry.name ?? "",
    speakerName: entry.participant ?? undefined,
    speakerId: entry.participant ?? undefined,
    text: entry.text ?? "",
    timestamp: entry.startTime ?? undefined,
    startTime: entry.startTime ?? undefined,
    endTime: entry.endTime ?? undefined,
    languageCode: entry.languageCode ?? undefined,
    confidence: 1,
  };
}

function mapRecording(recording: meet_v2.Schema$Recording): GoogleMeetRecording {
  return {
    id: recording.name ?? "",
    name: recording.name ?? "",
    uri: recording.driveDestination?.exportUri ?? undefined,
    fileId: recording.driveDestination?.file ?? undefined,
    startTime: recording.startTime ?? undefined,
    endTime: recording.endTime ?? undefined,
    state: recording.state ?? undefined,
  };
}

function participantDisplay(participant: meet_v2.Schema$Participant): {
  name: string;
  userType: GoogleMeetParticipant["userType"];
} {
  if (participant.signedinUser) {
    return {
      name:
        participant.signedinUser.displayName ?? participant.signedinUser.user ?? "Signed-in User",
      userType: "signed_in",
    };
  }
  if (participant.anonymousUser) {
    return {
      name: participant.anonymousUser.displayName ?? "Anonymous User",
      userType: "anonymous",
    };
  }
  if (participant.phoneUser) {
    return {
      name: participant.phoneUser.displayName ?? "Phone User",
      userType: "phone",
    };
  }
  return { name: "Unknown", userType: "unknown" };
}

function normalizeSpaceName(value: string): string {
  if (value.startsWith("spaces/")) {
    return value;
  }
  return `spaces/${value}`;
}

function normalizeConferenceRecordName(params: GoogleMeetGenerateReportInput): string {
  if (params.conferenceRecordName?.startsWith("conferenceRecords/")) {
    return params.conferenceRecordName;
  }
  if (params.meetingId?.startsWith("conferenceRecords/")) {
    return params.meetingId;
  }

  throw new Error(
    "Google Meet reports require conferenceRecordName in the form conferenceRecords/{record}."
  );
}

function toMeetAccessType(value: string | null | undefined): GoogleMeetAccessType | undefined {
  if (value === "OPEN" || value === "TRUSTED" || value === "RESTRICTED") {
    return value;
  }
  return undefined;
}

function durationMinutes(conference: GoogleMeetConferenceRecord): number {
  if (!conference.startTime || !conference.endTime) {
    return 0;
  }
  const start = new Date(conference.startTime).getTime();
  const end = new Date(conference.endTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, Math.round((end - start) / 60000));
}

function summarizeTranscript(entries: readonly GoogleMeetTranscript[]): {
  summary: string;
  keyPoints: string[];
  actionItems: GoogleMeetReport["actionItems"];
} {
  const lines = entries.map((entry) => entry.text.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      summary: "No transcript entries were available for this conference record.",
      keyPoints: [],
      actionItems: [],
    };
  }

  const plainText = lines.join(" ");
  const sentences = plainText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const summary = sentences.slice(0, 3).join(" ") || plainText.slice(0, 500);
  const keyPoints = lines.filter((line) => line.length >= 20).slice(0, 6);
  const actionItems = lines
    .filter((line) => /\b(action item|to[- ]?do|follow up|need to|will|should)\b/i.test(line))
    .slice(0, 6)
    .map((line) => ({
      description: line,
      priority: "medium" as const,
    }));

  return { summary, keyPoints, actionItems };
}

export function buildGoogleMeetCanonicalArtifact(
  input: GoogleMeetCanonicalArtifactInput
): GoogleMeetCanonicalArtifact {
  const participantById = new Map(
    input.participants.map((participant) => [participant.id, participant])
  );
  const transcriptStreams = input.transcriptArtifacts.map((artifact) => ({
    id: transcriptStreamId(artifact.name),
    kind: "google_transcript_entries" as const,
    artifactId: artifact.name,
    uri: artifact.documentUri,
    startedAt: artifact.startTime,
    endedAt: artifact.endTime,
    state: artifact.state,
  }));
  const docsStreams = input.transcriptArtifacts
    .filter(
      (artifact) => artifact.documentId || artifact.documentUri || input.googleDocsTranscriptText
    )
    .map((artifact) => ({
      id: `${transcriptStreamId(artifact.name)}:docs`,
      kind: "google_docs_transcript" as const,
      artifactId: artifact.documentId ?? artifact.name,
      uri: artifact.documentUri,
      startedAt: artifact.startTime,
      endedAt: artifact.endTime,
      state: artifact.state,
    }));
  const recordingStreams = input.recordings.map((recording) => ({
    id: `google-recording:${recording.name || recording.id}`,
    kind: "google_recording" as const,
    artifactId: recording.name || recording.id,
    uri: recording.uri,
    fileId: recording.fileId,
    startedAt: recording.startTime,
    endedAt: recording.endTime,
    state: recording.state,
  }));
  const botFreeStreams = botFreeCaptureStreams(input.botFreeCapture);
  const transcriptSpans = [
    ...input.transcriptEntries.map((entry, index) =>
      canonicalSpanFromEntry(entry, index, participantById)
    ),
    ...botFreeTranscriptSpans(input.botFreeCapture, participantById),
  ];
  const warnings = canonicalWarnings(input, participantById);
  const missingArtifacts = canonicalMissingArtifacts(input);
  const generatedNotes = canonicalGeneratedNotes({
    summary: input.summary,
    keyPoints: input.keyPoints,
    actionItems: input.actionItems,
    transcriptSpans,
  });

  return {
    schemaVersion: "elizaos.meeting_artifact.v1",
    source: "google_meet",
    meeting: {
      id: input.meetingId,
      conferenceRecordName: input.conferenceRecordName,
      spaceName: input.conference.spaceName,
      startedAt: input.conference.startTime,
      endedAt: input.conference.endTime,
      expireTime: input.conference.expireTime,
      durationMinutes: durationMinutes(input.conference),
    },
    streams: [...transcriptStreams, ...docsStreams, ...recordingStreams, ...botFreeStreams],
    participants: input.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName ?? participant.name,
      userType: participant.userType,
      nameProvenance: participantNameProvenance(participant),
    })),
    participantSessions:
      input.participantSessions?.map((session) => ({
        id: session.id,
        participantId: session.participantId,
        startedAt: session.startTime,
        endedAt: session.endTime,
        isActive: session.isActive,
      })) ?? [],
    transcriptSpans,
    generatedNotes,
    recordings: [...input.recordings],
    warnings,
    missingArtifacts,
    metrics: {
      transcriptWordCount: transcriptSpans.reduce((count, span) => count + wordCount(span.text), 0),
      participantCount: input.participants.length,
      participantSessionCount: input.participantSessions?.length ?? 0,
      transcriptSpanCount: transcriptSpans.length,
      recordingCount: input.recordings.length,
      missingArtifactCount: missingArtifacts.length,
      warningCount: warnings.length,
    },
  };
}

export function classifyGoogleMeetImportError(error: unknown): GoogleMeetMissingArtifact | null {
  const status = errorStatus(error);
  const message = errorMessage(error);
  const normalized = message.toLowerCase();

  if (status === 401 || normalized.includes("invalid_grant") || normalized.includes("revoked")) {
    return {
      artifactType: "conference",
      reason: "revoked_access",
      message: message || "Google Meet access was revoked.",
    };
  }
  if (status === 403) {
    return {
      artifactType: "conference",
      reason: normalized.includes("organizer") ? "organizer_only_artifact" : "permission_denied",
      message: message || "Google Meet artifacts are not visible to this account.",
    };
  }
  if (status === 404) {
    return {
      artifactType: "conference",
      reason: "meeting_not_found",
      message: message || "Google Meet conference record was not found.",
    };
  }
  if (status === 410 || normalized.includes("expired")) {
    return {
      artifactType: "recording",
      reason: "expired_media_url",
      message: message || "Google Meet media URL has expired.",
    };
  }

  return null;
}

function canonicalSpanFromEntry(
  entry: GoogleMeetTranscript,
  index: number,
  participantById: ReadonlyMap<string, GoogleMeetParticipant>
): GoogleMeetCanonicalTranscriptSpan {
  const participant = entry.speakerId ? participantById.get(entry.speakerId) : undefined;
  const entryId = entry.id || `transcript-entry-${index + 1}`;

  return {
    id: entryId,
    streamId: transcriptStreamId(transcriptNameFromEntry(entry.id)),
    source: "google_meet_transcript_entry" as const,
    text: entry.text,
    participantId: entry.speakerId,
    speakerLabel: participant?.displayName ?? participant?.name ?? entry.speakerName,
    startedAt: entry.startTime ?? entry.timestamp,
    endedAt: entry.endTime,
    languageCode: entry.languageCode,
    provenance: {
      transcriptName: transcriptNameFromEntry(entry.id),
      entryName: entry.id,
      participantName: entry.speakerId,
    },
  };
}

function botFreeTranscriptSpans(
  capture: GoogleMeetCanonicalArtifactInput["botFreeCapture"],
  participantById: ReadonlyMap<string, GoogleMeetParticipant>
): GoogleMeetCanonicalTranscriptSpan[] {
  if (!capture?.transcriptSpans?.length) {
    return [];
  }
  const streamId = capture.microphoneAudioUri
    ? `bot-free:${capture.id}:microphone`
    : `bot-free:${capture.id}:system-audio`;
  return capture.transcriptSpans.map((span, index) => {
    const participant = span.speakerId ? participantById.get(span.speakerId) : undefined;
    return {
      id: span.id || `bot-free-entry-${index + 1}`,
      streamId,
      source: "bot_free_capture" as const,
      text: span.text,
      participantId: span.speakerId,
      speakerLabel: participant?.displayName ?? participant?.name ?? span.speakerName,
      startedAt: span.startTime ?? span.timestamp,
      endedAt: span.endTime,
      languageCode: span.languageCode,
      provenance: {
        entryName: span.id,
        participantName: span.speakerId,
      },
    };
  });
}

function botFreeCaptureStreams(
  capture: GoogleMeetCanonicalArtifactInput["botFreeCapture"]
): GoogleMeetCanonicalStream[] {
  if (!capture) {
    return [];
  }
  const streams: GoogleMeetCanonicalStream[] = [];
  if (capture.systemAudioUri) {
    streams.push({
      id: `bot-free:${capture.id}:system-audio`,
      kind: "bot_free_system_audio",
      artifactId: capture.id,
      uri: capture.systemAudioUri,
      startedAt: capture.startedAt,
      endedAt: capture.endedAt,
    });
  }
  if (capture.microphoneAudioUri) {
    streams.push({
      id: `bot-free:${capture.id}:microphone`,
      kind: "bot_free_microphone",
      artifactId: capture.id,
      uri: capture.microphoneAudioUri,
      startedAt: capture.startedAt,
      endedAt: capture.endedAt,
    });
  }
  if (capture.screenVideoUri) {
    streams.push({
      id: `bot-free:${capture.id}:screen-video`,
      kind: "bot_free_screen_video",
      artifactId: capture.id,
      uri: capture.screenVideoUri,
      startedAt: capture.startedAt,
      endedAt: capture.endedAt,
    });
  }
  return streams;
}

function canonicalWarnings(
  input: GoogleMeetCanonicalArtifactInput,
  participantById: ReadonlyMap<string, GoogleMeetParticipant>
) {
  const warnings = [];
  const entriesText = normalizeText(input.transcriptEntries.map((entry) => entry.text).join(" "));
  const docsText = normalizeText(input.googleDocsTranscriptText ?? "");
  if (docsText && docsText !== entriesText) {
    warnings.push({
      code: "docs_transcript_mismatch" as const,
      message:
        "Google Meet transcript entries do not match the provided Google Docs transcript text.",
    });
  }
  for (const artifact of input.transcriptArtifacts) {
    if (artifact.documentId && !artifact.documentUri) {
      warnings.push({
        code: "organizer_only_artifact" as const,
        message: "Google Docs transcript exists but no document URI was visible to this account.",
        sourceName: artifact.name,
      });
    }
  }
  for (const recording of input.recordings) {
    if (recording.fileId && !recording.uri) {
      warnings.push({
        code: "expired_media_url" as const,
        message: "Google Meet recording file exists but no playback URI was visible.",
        sourceName: recording.name,
      });
    }
  }
  for (const entry of input.transcriptEntries) {
    if (!entry.text.trim()) {
      warnings.push({
        code: "transcript_entry_empty" as const,
        message: "Google Meet transcript entry contained no text.",
        sourceName: entry.id,
      });
    }
    if (entry.speakerId && !participantById.has(entry.speakerId)) {
      warnings.push({
        code: "speaker_reference_missing" as const,
        message: "Google Meet transcript entry referenced a participant not present in the roster.",
        sourceName: entry.id,
      });
    }
  }
  return warnings;
}

function canonicalMissingArtifacts(input: GoogleMeetCanonicalArtifactInput) {
  const missing: GoogleMeetMissingArtifact[] = [];
  if (input.transcriptArtifacts.length === 0) {
    missing.push({
      artifactType: "transcript",
      reason: input.conference.endTime ? "no_transcript" : "transcript_delayed",
      message: input.conference.endTime
        ? "No Google Meet transcript artifacts were available for the completed conference."
        : "Google Meet transcript artifacts are not available yet for the active conference.",
    });
  }
  for (const artifact of input.transcriptArtifacts) {
    if (
      artifact.state &&
      artifact.state !== "FILE_GENERATED" &&
      input.transcriptEntries.length === 0
    ) {
      missing.push({
        artifactType: "transcript",
        reason: "transcript_delayed",
        message: "Google Meet transcript artifact exists but entries are not available yet.",
        sourceName: artifact.name,
      });
    }
    if (artifact.documentId && !artifact.documentUri) {
      missing.push({
        artifactType: "transcript",
        reason: "organizer_only_artifact",
        message: "Google Docs transcript is organizer-only or not visible to this account.",
        sourceName: artifact.name,
      });
    }
  }
  if (input.recordings.length === 0) {
    missing.push({
      artifactType: "recording",
      reason: "missing_recording",
      message: "No Google Meet recording artifacts were available for this conference record.",
    });
  }
  for (const recording of input.recordings) {
    if (recording.fileId && !recording.uri) {
      missing.push({
        artifactType: "recording",
        reason: "expired_media_url",
        message: "Google Meet recording playback URI was unavailable or expired.",
        sourceName: recording.name,
      });
    }
  }
  if (input.participants.length > 0 && !input.participantSessions?.length) {
    missing.push({
      artifactType: "participant_sessions",
      reason: "permission_denied",
      message: "Participants were available but no participant sessions were imported.",
    });
  }
  return missing;
}

function canonicalGeneratedNotes(params: {
  summary: string;
  keyPoints: readonly string[];
  actionItems: GoogleMeetCanonicalArtifactInput["actionItems"];
  transcriptSpans: readonly GoogleMeetCanonicalTranscriptSpan[];
}) {
  const notes = [];
  if (params.summary.trim()) {
    notes.push({
      id: "summary",
      kind: "summary" as const,
      text: params.summary,
      sourceSpanIds: matchingSpanIds(params.transcriptSpans, params.summary),
    });
  }
  params.keyPoints.forEach((keyPoint, index) => {
    notes.push({
      id: `key-point-${index + 1}`,
      kind: "key_point" as const,
      text: keyPoint,
      sourceSpanIds: matchingSpanIds(params.transcriptSpans, keyPoint),
    });
  });
  params.actionItems.forEach((actionItem, index) => {
    notes.push({
      id: `action-item-${index + 1}`,
      kind: "action_item" as const,
      text: actionItem.description,
      sourceSpanIds: matchingSpanIds(params.transcriptSpans, actionItem.description),
      assignee: actionItem.assignee,
      dueDate: actionItem.dueDate,
      priority: actionItem.priority,
    });
  });
  return notes;
}

function matchingSpanIds(
  spans: readonly GoogleMeetCanonicalTranscriptSpan[],
  text: string
): string[] {
  const normalizedText = normalizeText(text);
  const matches = spans
    .filter((span) => {
      const normalizedSpan = normalizeText(span.text);
      return (
        normalizedSpan &&
        (normalizedText.includes(normalizedSpan) || normalizedSpan.includes(normalizedText))
      );
    })
    .map((span) => span.id);
  return matches.length > 0 ? matches : spans.map((span) => span.id);
}

function transcriptNameFromEntry(entryName: string | undefined): string {
  if (!entryName) {
    return "google-transcript";
  }
  const marker = "/entries/";
  const markerIndex = entryName.indexOf(marker);
  return markerIndex === -1 ? "google-transcript" : entryName.slice(0, markerIndex);
}

function transcriptStreamId(transcriptName: string): string {
  return `google-transcript:${transcriptName || "unknown"}`;
}

function participantNameProvenance(
  participant: GoogleMeetParticipant
): GoogleMeetCanonicalArtifact["participants"][number]["nameProvenance"] {
  if (participant.userType === "signed_in") {
    return "google_signed_in";
  }
  if (participant.userType === "anonymous") {
    return "google_anonymous";
  }
  if (participant.userType === "phone") {
    return "phone";
  }
  return "unknown";
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordCount(value: string): number {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(/\s+/).length : 0;
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const code = error.code;
  if (typeof code === "number") {
    return code;
  }
  const status = error.status;
  if (typeof status === "number") {
    return status;
  }
  const response = error.response;
  if (isRecord(response) && typeof response.status === "number") {
    return response.status;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (!isRecord(error)) {
    return String(error ?? "");
  }
  const message = error.message;
  if (typeof message === "string") {
    return message;
  }
  const response = error.response;
  if (isRecord(response) && typeof response.statusText === "string") {
    return response.statusText;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
