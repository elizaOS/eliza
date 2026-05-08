import type { meet_v2 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GoogleAccountRef,
  GoogleMeetAccessType,
  GoogleMeetConferenceRecord,
  GoogleMeetConferenceRecordInput,
  GoogleMeetCreateMeetingInput,
  GoogleMeetGenerateReportInput,
  GoogleMeetMeeting,
  GoogleMeetParticipant,
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
    const transcriptEntries = await this.collectTranscriptEntries(params, conferenceRecordName);
    const summary = summarizeTranscript(transcriptEntries);
    const recordings =
      params.includeRecordings === false
        ? []
        : await this.listMeetingRecordings({
            accountId: params.accountId,
            conferenceRecordName,
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
    };
  }

  private async collectTranscriptEntries(
    params: GoogleMeetGenerateReportInput,
    conferenceRecordName: string
  ): Promise<GoogleMeetTranscript[]> {
    if (
      params.includeSummary === false &&
      params.includeActionItems === false &&
      params.includeTranscript === false
    ) {
      return [];
    }

    const transcriptNames = params.transcriptName
      ? [params.transcriptName]
      : (
          await this.listMeetingTranscripts({
            accountId: params.accountId,
            conferenceRecordName,
          })
        ).map((transcript) => transcript.name);

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
    .filter((line) => /\b(action item|todo|follow up|need to|will|should)\b/i.test(line))
    .slice(0, 6)
    .map((line) => ({
      description: line,
      priority: "medium" as const,
    }));

  return { summary, keyPoints, actionItems };
}
