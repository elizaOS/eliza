/**
 * Deterministic Google Meet artifact import tests. The Google API clients are
 * stubbed with saved response-shaped objects; no live Google API is contacted.
 */
import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import {
  buildGoogleMeetCanonicalArtifact,
  classifyGoogleMeetImportError,
  GoogleMeetClient,
} from "./meet.js";

const CONFERENCE_RECORD = "conferenceRecords/conf_1";
const PARTICIPANT = `${CONFERENCE_RECORD}/participants/alice`;
const TRANSCRIPT = `${CONFERENCE_RECORD}/transcripts/transcript_1`;

describe("Google Meet canonical artifact mapping", () => {
  it("maps saved Google and bot-free artifacts into the canonical meeting schema", () => {
    const artifact = buildGoogleMeetCanonicalArtifact({
      meetingId: CONFERENCE_RECORD,
      conferenceRecordName: CONFERENCE_RECORD,
      conference: {
        id: CONFERENCE_RECORD,
        name: CONFERENCE_RECORD,
        spaceName: "spaces/abc-defg-hij",
        startTime: "2026-07-04T14:00:00.000Z",
        endTime: "2026-07-04T14:30:00.000Z",
        expireTime: "2026-08-03T14:30:00.000Z",
      },
      participants: [
        {
          id: PARTICIPANT,
          name: "Alice",
          displayName: "Alice",
          joinTime: "2026-07-04T14:00:10.000Z",
          leaveTime: "2026-07-04T14:29:00.000Z",
          isActive: false,
          userType: "signed_in",
        },
      ],
      participantSessions: [
        {
          id: `${PARTICIPANT}/participantSessions/session_1`,
          name: `${PARTICIPANT}/participantSessions/session_1`,
          participantId: PARTICIPANT,
          participantName: PARTICIPANT,
          startTime: "2026-07-04T14:00:10.000Z",
          endTime: "2026-07-04T14:29:00.000Z",
          isActive: false,
        },
      ],
      transcriptArtifacts: [
        {
          id: TRANSCRIPT,
          name: TRANSCRIPT,
          documentId: "doc_1",
          documentUri: "https://docs.google.com/document/d/doc_1",
          startTime: "2026-07-04T14:01:00.000Z",
          endTime: "2026-07-04T14:29:30.000Z",
          state: "FILE_GENERATED",
        },
      ],
      transcriptEntries: [
        {
          id: `${TRANSCRIPT}/entries/entry_1`,
          speakerName: PARTICIPANT,
          speakerId: PARTICIPANT,
          text: "Alice will send notes.",
          startTime: "2026-07-04T14:02:00.000Z",
          endTime: "2026-07-04T14:02:05.000Z",
          languageCode: "en-US",
        },
      ],
      recordings: [
        {
          id: `${CONFERENCE_RECORD}/recordings/recording_1`,
          name: `${CONFERENCE_RECORD}/recordings/recording_1`,
          uri: "https://drive.google.com/file/d/file_1/view",
          fileId: "file_1",
          startTime: "2026-07-04T14:00:00.000Z",
          endTime: "2026-07-04T14:30:00.000Z",
          state: "FILE_GENERATED",
        },
        {
          id: `${CONFERENCE_RECORD}/recordings/recording_2`,
          name: `${CONFERENCE_RECORD}/recordings/recording_2`,
          fileId: "file_2",
          startTime: "2026-07-04T14:10:00.000Z",
          endTime: "2026-07-04T14:20:00.000Z",
          state: "FILE_GENERATED",
        },
      ],
      summary: "Alice will send notes.",
      keyPoints: ["Alice will send notes."],
      actionItems: [{ description: "Alice will send notes.", priority: "medium" }],
      googleDocsTranscriptText: "Alice edited the Google Docs transcript after the meeting.",
      botFreeCapture: {
        id: "bot-free-meet-1",
        systemAudioUri: "file:///captures/system.wav",
        microphoneAudioUri: "file:///captures/mic.wav",
        screenVideoUri: "file:///captures/screen.webm",
        startedAt: "2026-07-04T14:00:00.000Z",
        endedAt: "2026-07-04T14:30:00.000Z",
        transcriptSpans: [
          {
            id: "bot-free-entry-1",
            speakerName: "Alice",
            speakerId: PARTICIPANT,
            text: "Alice will send notes.",
            startTime: "2026-07-04T14:02:00.000Z",
            endTime: "2026-07-04T14:02:05.000Z",
          },
        ],
      },
    });

    expect(artifact.schemaVersion).toBe("elizaos.meeting_artifact.v1");
    expect(artifact.meeting.durationMinutes).toBe(30);
    expect(artifact.participants).toEqual([
      expect.objectContaining({
        id: PARTICIPANT,
        displayName: "Alice",
        nameProvenance: "google_signed_in",
      }),
    ]);
    expect(artifact.participantSessions).toHaveLength(1);
    expect(artifact.streams.map((stream) => stream.kind)).toEqual(
      expect.arrayContaining([
        "google_transcript_entries",
        "google_docs_transcript",
        "google_recording",
        "bot_free_system_audio",
        "bot_free_microphone",
        "bot_free_screen_video",
      ])
    );
    expect(artifact.transcriptSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "google_meet_transcript_entry",
          participantId: PARTICIPANT,
          speakerLabel: "Alice",
          text: "Alice will send notes.",
        }),
        expect.objectContaining({
          source: "bot_free_capture",
          participantId: PARTICIPANT,
        }),
      ])
    );
    expect(artifact.generatedNotes.map((note) => note.kind)).toEqual([
      "summary",
      "key_point",
      "action_item",
    ]);
    expect(artifact.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["docs_transcript_mismatch", "expired_media_url"])
    );
    expect(artifact.missingArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactType: "recording",
          reason: "expired_media_url",
        }),
      ])
    );
    expect(artifact.metrics.transcriptWordCount).toBe(8);
  });

  it("classifies Google Meet import failures into human-readable missing artifacts", () => {
    expect(classifyGoogleMeetImportError({ code: 403, message: "Permission denied" })).toEqual(
      expect.objectContaining({ reason: "permission_denied" })
    );
    expect(
      classifyGoogleMeetImportError({ response: { status: 404 }, message: "Not found" })
    ).toEqual(expect.objectContaining({ reason: "meeting_not_found" }));
    expect(classifyGoogleMeetImportError({ code: 401, message: "invalid_grant revoked" })).toEqual(
      expect.objectContaining({ reason: "revoked_access" })
    );
    expect(classifyGoogleMeetImportError({ code: 410, message: "media URL expired" })).toEqual(
      expect.objectContaining({ reason: "expired_media_url" })
    );
  });

  it("generates a canonical artifact from paged Google Meet API responses", async () => {
    const fakeMeet = {
      conferenceRecords: {
        get: vi.fn(async () => ({
          data: {
            name: CONFERENCE_RECORD,
            space: "spaces/abc-defg-hij",
            startTime: "2026-07-04T14:00:00.000Z",
            endTime: "2026-07-04T14:30:00.000Z",
          },
        })),
        participants: {
          list: vi.fn(async () => ({
            data: {
              participants: [
                {
                  name: PARTICIPANT,
                  earliestStartTime: "2026-07-04T14:00:10.000Z",
                  latestEndTime: "2026-07-04T14:29:00.000Z",
                  signedinUser: { displayName: "Alice", user: "users/alice" },
                },
              ],
            },
          })),
          participantSessions: {
            list: vi.fn(async () => ({
              data: {
                participantSessions: [
                  {
                    name: `${PARTICIPANT}/participantSessions/session_1`,
                    startTime: "2026-07-04T14:00:10.000Z",
                    endTime: "2026-07-04T14:29:00.000Z",
                  },
                ],
              },
            })),
          },
        },
        transcripts: {
          list: vi.fn(async () => ({
            data: {
              transcripts: [
                {
                  name: TRANSCRIPT,
                  docsDestination: {
                    document: "doc_1",
                    exportUri: "https://docs.google.com/document/d/doc_1",
                  },
                  startTime: "2026-07-04T14:01:00.000Z",
                  endTime: "2026-07-04T14:29:30.000Z",
                  state: "FILE_GENERATED",
                },
              ],
            },
          })),
          entries: {
            list: vi.fn(async () => ({
              data: {
                transcriptEntries: [
                  {
                    name: `${TRANSCRIPT}/entries/entry_1`,
                    participant: PARTICIPANT,
                    text: "Alice will send notes.",
                    startTime: "2026-07-04T14:02:00.000Z",
                    endTime: "2026-07-04T14:02:05.000Z",
                    languageCode: "en-US",
                  },
                ],
              },
            })),
          },
        },
        recordings: {
          list: vi.fn(async () => ({
            data: {
              recordings: [
                {
                  name: `${CONFERENCE_RECORD}/recordings/recording_1`,
                  driveDestination: {
                    file: "file_1",
                    exportUri: "https://drive.google.com/file/d/file_1/view",
                  },
                  startTime: "2026-07-04T14:00:00.000Z",
                  endTime: "2026-07-04T14:30:00.000Z",
                  state: "FILE_GENERATED",
                },
              ],
            },
          })),
        },
      },
    };
    const factory = { meet: vi.fn(async () => fakeMeet) } as unknown as GoogleApiClientFactory;
    const client = new GoogleMeetClient(factory);

    const report = await client.generateReport({
      accountId: "acct_google_1",
      conferenceRecordName: CONFERENCE_RECORD,
      googleDocsTranscriptText: "Alice will send notes.",
    });

    expect(report.participantSessions).toHaveLength(1);
    expect(report.canonicalArtifact.participantSessions).toHaveLength(1);
    expect(report.canonicalArtifact.transcriptSpans).toEqual([
      expect.objectContaining({
        participantId: PARTICIPANT,
        speakerLabel: "Alice",
        text: "Alice will send notes.",
      }),
    ]);
    expect(report.canonicalArtifact.streams.map((stream) => stream.kind)).toEqual(
      expect.arrayContaining([
        "google_transcript_entries",
        "google_docs_transcript",
        "google_recording",
      ])
    );
    expect(report.canonicalArtifact.missingArtifacts).toEqual([]);
    expect(fakeMeet.conferenceRecords.participants.participantSessions.list).toHaveBeenCalledWith({
      parent: PARTICIPANT,
      pageSize: 100,
      pageToken: undefined,
    });
  });
});
