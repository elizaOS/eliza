/**
 * Canonical meeting artifacts (#12487).
 *
 * This is the durable meeting-record shape that can be produced by platform
 * bots, bot-free capture, local/system/mobile/room microphones, cloud-agent
 * capture, and imported benchmark corpora. The contract stays pure and
 * browser-safe so adapters, app-core, UI, and benchmarks can all validate the
 * same artifact without importing runtime/native code.
 */

import type { MeetingPlatform } from "./meetings.js";
import type { TranscriptSegment } from "./transcripts.js";

export const MEETING_ARTIFACT_SCHEMA_VERSION =
  "eliza.meeting_artifact.v1" as const;

export const MEETING_ARTIFACT_CAPTURE_MODES = [
  "platform_bot",
  "bot_free_browser",
  "local_capture",
  "cloud_agent_capture",
  "imported_corpus",
] as const;

export const MEETING_ARTIFACT_SOURCE_STREAM_KINDS = [
  "local_mic",
  "system_audio",
  "tab_audio",
  "bot_participant_audio",
  "mixed_room_mic",
  "recording",
  "imported_corpus_audio",
  "mobile_mic",
  "cloud_agent_audio",
] as const;

export const MEETING_SPEAKER_NAME_PROVENANCE = [
  "platform",
  "calendar",
  "self_introduction",
  "user_correction",
  "voice_profile",
  "llm_inference",
  "unknown",
] as const;

export type MeetingArtifactCaptureMode =
  (typeof MEETING_ARTIFACT_CAPTURE_MODES)[number];

export type MeetingArtifactSourceStreamKind =
  (typeof MEETING_ARTIFACT_SOURCE_STREAM_KINDS)[number];

export type MeetingArtifactPlatform =
  | MeetingPlatform
  | "local"
  | "imported_corpus"
  | "unknown";

export type MeetingConsentState =
  | "unknown"
  | "granted"
  | "denied"
  | "not_required"
  | "redacted";

export type MeetingSpeakerNameProvenance =
  (typeof MEETING_SPEAKER_NAME_PROVENANCE)[number];

export type MeetingEntityBindingStatus =
  | "active"
  | "merged"
  | "split"
  | "deleted"
  | "revoked"
  | "unknown";

export interface MeetingArtifactConsent {
  state: MeetingConsentState;
  evidence?: string;
  grantedByEntityId?: string;
  grantedAt?: string;
}

export interface MeetingArtifactRetentionPolicy {
  retainAudio: boolean;
  retainTranscript: boolean;
  scope: "owner-private" | "user-private" | "agent-private" | "global";
  expiresAt?: string;
}

export interface MeetingArtifactMediaRef {
  /** Canonical `Media.id`; do not add a second file id namespace. */
  id: string;
  /** Served media-store URL, normally `/api/media/<sha256>.<ext>`. */
  url: string;
  mimeType: string;
  checksum?: string;
  durationMs?: number;
  title?: string;
}

export interface MeetingArtifactSourceStream {
  id: string;
  kind: MeetingArtifactSourceStreamKind;
  mediaRefId: string;
  label?: string;
  platformParticipantId?: string;
  channel?: number;
}

export interface MeetingArtifactPlatformParticipant {
  id: string;
  displayName?: string;
  sessionId?: string;
  tileId?: string;
  joinedAtMs?: number;
  leftAtMs?: number;
}

export interface MeetingArtifactSpeakerName {
  displayName: string;
  provenance: MeetingSpeakerNameProvenance;
  confidence: number;
  evidenceSpanIds?: string[];
}

export interface MeetingArtifactDiarizedSpeaker {
  id: string;
  sourceStreamIds: string[];
  platformParticipantIds?: string[];
  entityBindingId?: string;
  name?: MeetingArtifactSpeakerName;
  status?: "active" | "unknown" | "merged" | "split" | "deleted";
}

export interface MeetingArtifactEntityBinding {
  id: string;
  diarizedSpeakerId: string;
  entityId: string | null;
  status: MeetingEntityBindingStatus;
  confidence: number;
  provenance: MeetingSpeakerNameProvenance;
  mergedIntoEntityId?: string;
  splitFromEntityId?: string;
  deletedAt?: string;
}

export interface MeetingArtifactCorrection {
  atMs: number;
  correctedByEntityId?: string;
  previousText?: string;
  previousSpeakerId?: string;
  reason: "rename" | "merge" | "split" | "delete" | "text_edit";
}

export interface MeetingArtifactWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  speakerId?: string;
  sourceStreamId?: string;
}

export interface MeetingArtifactTranscriptSpan {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words: MeetingArtifactWord[];
  speakerId?: string;
  platformParticipantId?: string;
  sourceStreamId: string;
  confidence?: number;
  overlap?: boolean;
  correctionHistory?: MeetingArtifactCorrection[];
}

export interface MeetingArtifactGroundedText {
  id: string;
  text: string;
  transcriptSpanIds: string[];
  confidence?: number;
}

export interface MeetingArtifactActionItem extends MeetingArtifactGroundedText {
  assigneeEntityId?: string;
  dueAt?: string;
  status?: "open" | "done" | "dismissed";
}

export interface MeetingArtifactEvidence {
  id: string;
  kind:
    | "media"
    | "log"
    | "metrics"
    | "screenshot"
    | "video"
    | "benchmark_report";
  mediaRefId?: string;
  transcriptSpanIds?: string[];
  description?: string;
}

export interface MeetingArtifact {
  schemaVersion: typeof MEETING_ARTIFACT_SCHEMA_VERSION;
  artifactId: string;
  meeting: {
    id: string;
    platform: MeetingArtifactPlatform;
    captureMode: MeetingArtifactCaptureMode;
    title?: string;
    nativeMeetingId?: string;
    startedAt?: string;
    endedAt?: string;
    consent: MeetingArtifactConsent;
    retentionPolicy: MeetingArtifactRetentionPolicy;
  };
  media: MeetingArtifactMediaRef[];
  sourceStreams: MeetingArtifactSourceStream[];
  platformParticipants: MeetingArtifactPlatformParticipant[];
  diarizedSpeakers: MeetingArtifactDiarizedSpeaker[];
  entityBindings: MeetingArtifactEntityBinding[];
  transcriptSpans: MeetingArtifactTranscriptSpan[];
  notes: MeetingArtifactGroundedText[];
  actionItems: MeetingArtifactActionItem[];
  decisions: MeetingArtifactGroundedText[];
  evidenceArtifacts: MeetingArtifactEvidence[];
  provenance?: {
    createdAt?: string;
    generator?: string;
    benchmarkCorpus?: string;
    license?: string;
    citation?: string;
  };
}

export interface MeetingArtifactValidation {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function collectIds(
  rows: unknown[],
  path: string,
  errors: string[],
): Set<string> {
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    if (!isNonEmptyString(row.id)) {
      errors.push(`${path}[${index}].id is required`);
      return;
    }
    if (ids.has(row.id)) errors.push(`duplicate ${path} id: ${row.id}`);
    ids.add(row.id);
  });
  return ids;
}

function requireEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${path} must be one of: ${allowed.join(", ")}`);
  }
}

function requireTimeRange(
  row: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!isNumber(row.startMs) || row.startMs < 0) {
    errors.push(`${path}.startMs must be a non-negative number`);
  }
  if (
    !isNumber(row.endMs) ||
    row.endMs <= (isNumber(row.startMs) ? row.startMs : 0)
  ) {
    errors.push(`${path}.endMs must be greater than startMs`);
  }
}

function requireRefs(
  ids: unknown,
  known: Set<string>,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  ids.forEach((id, index) => {
    if (!isNonEmptyString(id) || !known.has(id)) {
      errors.push(`${path}[${index}] references missing id: ${String(id)}`);
    }
  });
}

function mediaUrlIsContentAddressed(url: string): boolean {
  return /^\/api\/media\/[a-f0-9]{16,64}\.[a-z0-9]+$/i.test(url);
}

export function validateMeetingArtifact(
  value: unknown,
): MeetingArtifactValidation {
  const errors: string[] = [];
  if (!isRecord(value))
    return { valid: false, errors: ["artifact must be an object"] };
  if (value.schemaVersion !== MEETING_ARTIFACT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MEETING_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.artifactId))
    errors.push("artifactId is required");

  const meeting = value.meeting;
  if (!isRecord(meeting)) {
    errors.push("meeting must be an object");
  } else {
    if (!isNonEmptyString(meeting.id)) errors.push("meeting.id is required");
    requireEnum(
      meeting.captureMode,
      MEETING_ARTIFACT_CAPTURE_MODES,
      "meeting.captureMode",
      errors,
    );
    if (!isNonEmptyString(meeting.platform))
      errors.push("meeting.platform is required");
    const consent = meeting.consent;
    if (!isRecord(consent)) {
      errors.push("meeting.consent must be an object");
    } else {
      requireEnum(
        consent.state,
        ["unknown", "granted", "denied", "not_required", "redacted"],
        "meeting.consent.state",
        errors,
      );
    }
    const retentionPolicy = meeting.retentionPolicy;
    if (!isRecord(retentionPolicy)) {
      errors.push("meeting.retentionPolicy must be an object");
    } else {
      if (typeof retentionPolicy.retainAudio !== "boolean") {
        errors.push("meeting.retentionPolicy.retainAudio must be boolean");
      }
      if (typeof retentionPolicy.retainTranscript !== "boolean") {
        errors.push("meeting.retentionPolicy.retainTranscript must be boolean");
      }
    }
  }

  const media = Array.isArray(value.media) ? value.media : [];
  const streams = Array.isArray(value.sourceStreams) ? value.sourceStreams : [];
  const participants = Array.isArray(value.platformParticipants)
    ? value.platformParticipants
    : [];
  const speakers = Array.isArray(value.diarizedSpeakers)
    ? value.diarizedSpeakers
    : [];
  const bindings = Array.isArray(value.entityBindings)
    ? value.entityBindings
    : [];
  const spans = Array.isArray(value.transcriptSpans)
    ? value.transcriptSpans
    : [];

  for (const [key, rows] of [
    ["media", value.media],
    ["sourceStreams", value.sourceStreams],
    ["platformParticipants", value.platformParticipants],
    ["diarizedSpeakers", value.diarizedSpeakers],
    ["entityBindings", value.entityBindings],
    ["transcriptSpans", value.transcriptSpans],
    ["notes", value.notes],
    ["actionItems", value.actionItems],
    ["decisions", value.decisions],
    ["evidenceArtifacts", value.evidenceArtifacts],
  ] as const) {
    if (!Array.isArray(rows)) errors.push(`${key} must be an array`);
  }

  const mediaIds = collectIds(media, "media", errors);
  const streamIds = collectIds(streams, "sourceStreams", errors);
  const participantIds = collectIds(
    participants,
    "platformParticipants",
    errors,
  );
  const speakerIds = collectIds(speakers, "diarizedSpeakers", errors);
  const bindingIds = collectIds(bindings, "entityBindings", errors);
  const spanIds = collectIds(spans, "transcriptSpans", errors);
  collectIds(Array.isArray(value.notes) ? value.notes : [], "notes", errors);
  collectIds(
    Array.isArray(value.actionItems) ? value.actionItems : [],
    "actionItems",
    errors,
  );
  collectIds(
    Array.isArray(value.decisions) ? value.decisions : [],
    "decisions",
    errors,
  );
  collectIds(
    Array.isArray(value.evidenceArtifacts) ? value.evidenceArtifacts : [],
    "evidenceArtifacts",
    errors,
  );

  media.forEach((row, index) => {
    if (!isRecord(row)) return;
    if ("fileId" in row) {
      errors.push(`media[${index}] must not define fileId; use Media.id/url`);
    }
    if (!isNonEmptyString(row.url) || !mediaUrlIsContentAddressed(row.url)) {
      errors.push(
        `media[${index}].url must be a content-addressed /api/media URL`,
      );
    }
    if (!isNonEmptyString(row.mimeType))
      errors.push(`media[${index}].mimeType is required`);
  });

  streams.forEach((row, index) => {
    if (!isRecord(row)) return;
    requireEnum(
      row.kind,
      MEETING_ARTIFACT_SOURCE_STREAM_KINDS,
      `sourceStreams[${index}].kind`,
      errors,
    );
    if (!isNonEmptyString(row.mediaRefId) || !mediaIds.has(row.mediaRefId)) {
      errors.push(
        `sourceStreams[${index}].mediaRefId references missing media`,
      );
    }
    if (
      row.platformParticipantId !== undefined &&
      (!isNonEmptyString(row.platformParticipantId) ||
        !participantIds.has(row.platformParticipantId))
    ) {
      errors.push(
        `sourceStreams[${index}].platformParticipantId references missing participant`,
      );
    }
  });

  speakers.forEach((row, index) => {
    if (!isRecord(row)) return;
    requireRefs(
      row.sourceStreamIds,
      streamIds,
      `diarizedSpeakers[${index}].sourceStreamIds`,
      errors,
    );
    if (row.platformParticipantIds !== undefined) {
      requireRefs(
        row.platformParticipantIds,
        participantIds,
        `diarizedSpeakers[${index}].platformParticipantIds`,
        errors,
      );
    }
    if (
      row.entityBindingId !== undefined &&
      (!isNonEmptyString(row.entityBindingId) ||
        !bindingIds.has(row.entityBindingId))
    ) {
      errors.push(
        `diarizedSpeakers[${index}].entityBindingId references missing binding`,
      );
    }
    const name = row.name;
    if (name !== undefined) {
      if (!isRecord(name)) {
        errors.push(`diarizedSpeakers[${index}].name must be an object`);
      } else {
        requireEnum(
          name.provenance,
          MEETING_SPEAKER_NAME_PROVENANCE,
          `diarizedSpeakers[${index}].name.provenance`,
          errors,
        );
        if (
          !isNumber(name.confidence) ||
          name.confidence < 0 ||
          name.confidence > 1
        ) {
          errors.push(
            `diarizedSpeakers[${index}].name.confidence must be in [0,1]`,
          );
        }
      }
    }
  });

  bindings.forEach((row, index) => {
    if (!isRecord(row)) return;
    if (
      !isNonEmptyString(row.diarizedSpeakerId) ||
      !speakerIds.has(row.diarizedSpeakerId)
    ) {
      errors.push(
        `entityBindings[${index}].diarizedSpeakerId references missing speaker`,
      );
    }
    requireEnum(
      row.status,
      ["active", "merged", "split", "deleted", "revoked", "unknown"],
      `entityBindings[${index}].status`,
      errors,
    );
    requireEnum(
      row.provenance,
      MEETING_SPEAKER_NAME_PROVENANCE,
      `entityBindings[${index}].provenance`,
      errors,
    );
    if (!isNumber(row.confidence) || row.confidence < 0 || row.confidence > 1) {
      errors.push(`entityBindings[${index}].confidence must be in [0,1]`);
    }
  });

  spans.forEach((row, index) => {
    if (!isRecord(row)) return;
    requireTimeRange(row, `transcriptSpans[${index}]`, errors);
    if (
      !isNonEmptyString(row.sourceStreamId) ||
      !streamIds.has(row.sourceStreamId)
    ) {
      errors.push(
        `transcriptSpans[${index}].sourceStreamId references missing stream`,
      );
    }
    if (
      row.speakerId !== undefined &&
      (!isNonEmptyString(row.speakerId) || !speakerIds.has(row.speakerId))
    ) {
      errors.push(
        `transcriptSpans[${index}].speakerId references missing speaker`,
      );
    }
    if (
      row.platformParticipantId !== undefined &&
      (!isNonEmptyString(row.platformParticipantId) ||
        !participantIds.has(row.platformParticipantId))
    ) {
      errors.push(
        `transcriptSpans[${index}].platformParticipantId references missing participant`,
      );
    }
    const words = Array.isArray(row.words) ? row.words : [];
    if (!Array.isArray(row.words))
      errors.push(`transcriptSpans[${index}].words must be an array`);
    words.forEach((word, wordIndex) => {
      if (!isRecord(word)) {
        errors.push(
          `transcriptSpans[${index}].words[${wordIndex}] must be an object`,
        );
        return;
      }
      if (!isNonEmptyString(word.text)) {
        errors.push(
          `transcriptSpans[${index}].words[${wordIndex}].text is required`,
        );
      }
      requireTimeRange(
        word,
        `transcriptSpans[${index}].words[${wordIndex}]`,
        errors,
      );
    });
  });

  for (const key of ["notes", "actionItems", "decisions"] as const) {
    const rows = Array.isArray(value[key]) ? value[key] : [];
    rows.forEach((row, index) => {
      if (!isRecord(row)) return;
      requireRefs(
        row.transcriptSpanIds,
        spanIds,
        `${key}[${index}].transcriptSpanIds`,
        errors,
      );
    });
  }

  const evidenceRows = Array.isArray(value.evidenceArtifacts)
    ? value.evidenceArtifacts
    : [];
  evidenceRows.forEach((row, index) => {
    if (!isRecord(row)) return;
    if (
      row.mediaRefId !== undefined &&
      (!isNonEmptyString(row.mediaRefId) || !mediaIds.has(row.mediaRefId))
    ) {
      errors.push(
        `evidenceArtifacts[${index}].mediaRefId references missing media`,
      );
    }
    if (row.transcriptSpanIds !== undefined) {
      requireRefs(
        row.transcriptSpanIds,
        spanIds,
        `evidenceArtifacts[${index}].transcriptSpanIds`,
        errors,
      );
    }
  });

  return { valid: errors.length === 0, errors };
}

export function assertValidMeetingArtifact(
  value: unknown,
): asserts value is MeetingArtifact {
  const validation = validateMeetingArtifact(value);
  if (!validation.valid) {
    throw new Error(
      `invalid meeting artifact: ${validation.errors.join("; ")}`,
    );
  }
}

export function meetingArtifactToTranscriptSegments(
  artifact: MeetingArtifact,
): TranscriptSegment[] {
  return artifact.transcriptSpans.map((span) => {
    const speaker = artifact.diarizedSpeakers.find(
      (candidate) => candidate.id === span.speakerId,
    );
    return {
      id: span.id,
      speakerLabel: speaker?.name?.displayName ?? span.speakerId,
      speakerEntityId: speaker?.entityBindingId
        ? (artifact.entityBindings.find(
            (binding) => binding.id === speaker.entityBindingId,
          )?.entityId ?? undefined)
        : undefined,
      startMs: span.startMs,
      endMs: span.endMs,
      text: span.text,
      words: span.words.map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        confidence: word.confidence,
      })),
      confidence: span.confidence,
    };
  });
}

function media(id: string, mimeType = "audio/wav"): MeetingArtifactMediaRef {
  return {
    id,
    url: `/api/media/${"a".repeat(64)}.${mimeType === "audio/wav" ? "wav" : "json"}`,
    mimeType,
    checksum: "a".repeat(64),
  };
}

function word(
  text: string,
  startMs: number,
  endMs: number,
): MeetingArtifactWord {
  return { text, startMs, endMs, confidence: 0.98 };
}

function baseArtifact(overrides: Partial<MeetingArtifact>): MeetingArtifact {
  return {
    schemaVersion: MEETING_ARTIFACT_SCHEMA_VERSION,
    artifactId: "meeting-artifact-fixture",
    meeting: {
      id: "meeting-fixture",
      platform: "google_meet",
      captureMode: "platform_bot",
      consent: { state: "granted", evidence: "calendar invite" },
      retentionPolicy: {
        retainAudio: true,
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    media: [media("media-main")],
    sourceStreams: [
      {
        id: "stream-main",
        kind: "mixed_room_mic",
        mediaRefId: "media-main",
        platformParticipantId: "tile-room",
      },
    ],
    platformParticipants: [{ id: "tile-room", displayName: "Room 12" }],
    diarizedSpeakers: [],
    entityBindings: [],
    transcriptSpans: [],
    notes: [],
    actionItems: [],
    decisions: [],
    evidenceArtifacts: [],
    ...overrides,
  };
}

export function buildMeetingArtifactFixtures(): Record<
  string,
  MeetingArtifact
> {
  const googleMeetRoom = baseArtifact({
    artifactId: "meet-room-three-speakers",
    diarizedSpeakers: [1, 2, 3].map((index) => ({
      id: `speaker-${index}`,
      sourceStreamIds: ["stream-main"],
      platformParticipantIds: ["tile-room"],
      name: {
        displayName: `Room speaker ${index}`,
        provenance: index === 1 ? "platform" : "unknown",
        confidence: index === 1 ? 0.7 : 0,
      },
      status: index === 3 ? "unknown" : "active",
    })),
    transcriptSpans: [1, 2, 3].map((index) => ({
      id: `span-${index}`,
      startMs: (index - 1) * 1000,
      endMs: index * 1000,
      text: `speaker ${index} update`,
      words: [word("speaker", (index - 1) * 1000, (index - 1) * 1000 + 400)],
      speakerId: `speaker-${index}`,
      platformParticipantId: "tile-room",
      sourceStreamId: "stream-main",
    })),
    notes: [
      {
        id: "note-1",
        text: "Three speakers shared one tile.",
        transcriptSpanIds: ["span-1"],
      },
    ],
  });

  const zoomPerParticipant = baseArtifact({
    artifactId: "zoom-per-participant",
    meeting: {
      id: "zoom-fixture",
      platform: "zoom",
      nativeMeetingId: "123456789",
      captureMode: "platform_bot",
      consent: { state: "granted" },
      retentionPolicy: {
        retainAudio: true,
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    media: [media("media-alice"), media("media-bob")],
    sourceStreams: [
      {
        id: "stream-alice",
        kind: "bot_participant_audio",
        mediaRefId: "media-alice",
        platformParticipantId: "zoom-alice",
      },
      {
        id: "stream-bob",
        kind: "bot_participant_audio",
        mediaRefId: "media-bob",
        platformParticipantId: "zoom-bob",
      },
    ],
    platformParticipants: [
      { id: "zoom-alice", displayName: "Alice" },
      { id: "zoom-bob", displayName: "Bob" },
    ],
    diarizedSpeakers: [
      {
        id: "speaker-alice",
        sourceStreamIds: ["stream-alice"],
        platformParticipantIds: ["zoom-alice"],
        entityBindingId: "binding-alice",
        name: {
          displayName: "Alice",
          provenance: "platform",
          confidence: 0.95,
        },
      },
      {
        id: "speaker-bob",
        sourceStreamIds: ["stream-bob"],
        platformParticipantIds: ["zoom-bob"],
        entityBindingId: "binding-bob",
        name: { displayName: "Bob", provenance: "calendar", confidence: 0.9 },
      },
    ],
    entityBindings: [
      {
        id: "binding-alice",
        diarizedSpeakerId: "speaker-alice",
        entityId: "entity-alice",
        status: "active",
        confidence: 0.95,
        provenance: "voice_profile",
      },
      {
        id: "binding-bob",
        diarizedSpeakerId: "speaker-bob",
        entityId: "entity-bob",
        status: "active",
        confidence: 0.9,
        provenance: "calendar",
      },
    ],
    transcriptSpans: [
      {
        id: "span-alice",
        startMs: 0,
        endMs: 900,
        text: "hello bob",
        words: [word("hello", 0, 400), word("bob", 450, 900)],
        speakerId: "speaker-alice",
        platformParticipantId: "zoom-alice",
        sourceStreamId: "stream-alice",
      },
    ],
  });

  const inPersonRoomMic = baseArtifact({
    artifactId: "in-person-room-mic",
    meeting: {
      id: "room-fixture",
      platform: "local",
      captureMode: "local_capture",
      consent: { state: "not_required" },
      retentionPolicy: {
        retainAudio: true,
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    platformParticipants: [],
    sourceStreams: [
      { id: "room-mic", kind: "mixed_room_mic", mediaRefId: "media-main" },
    ],
    diarizedSpeakers: [
      {
        id: "room-speaker",
        sourceStreamIds: ["room-mic"],
        name: {
          displayName: "Unknown speaker",
          provenance: "unknown",
          confidence: 0,
        },
        status: "unknown",
      },
    ],
    transcriptSpans: [
      {
        id: "room-span",
        startMs: 0,
        endMs: 1000,
        text: "unattributed room speech",
        words: [word("unattributed", 0, 500)],
        speakerId: "room-speaker",
        sourceStreamId: "room-mic",
        overlap: true,
      },
    ],
  });

  const importedCorpus = baseArtifact({
    artifactId: "imported-corpus-ami-style",
    meeting: {
      id: "ami-fixture",
      platform: "imported_corpus",
      captureMode: "imported_corpus",
      consent: { state: "not_required", evidence: "research corpus license" },
      retentionPolicy: {
        retainAudio: false,
        retainTranscript: true,
        scope: "agent-private",
      },
    },
    sourceStreams: [
      {
        id: "corpus-audio",
        kind: "imported_corpus_audio",
        mediaRefId: "media-main",
      },
    ],
    diarizedSpeakers: [
      {
        id: "corpus-speaker",
        sourceStreamIds: ["corpus-audio"],
        name: {
          displayName: "Corpus speaker A",
          provenance: "self_introduction",
          confidence: 0.8,
        },
      },
    ],
    transcriptSpans: [
      {
        id: "corpus-span",
        startMs: 0,
        endMs: 1200,
        text: "corpus transcript",
        words: [word("corpus", 0, 500), word("transcript", 550, 1200)],
        speakerId: "corpus-speaker",
        sourceStreamId: "corpus-audio",
      },
    ],
    evidenceArtifacts: [
      {
        id: "license",
        kind: "benchmark_report",
        mediaRefId: "media-main",
        description: "License/citation manifest",
      },
    ],
    provenance: {
      benchmarkCorpus: "AMI-style fixture",
      license: "fixture-only",
      citation: "Synthetic fixture for schema validation",
    },
  });

  const oneSpeakerAcrossStreams = baseArtifact({
    artifactId: "one-speaker-across-streams",
    media: [media("media-local"), media("media-system")],
    sourceStreams: [
      { id: "local-mic", kind: "local_mic", mediaRefId: "media-local" },
      { id: "system-audio", kind: "system_audio", mediaRefId: "media-system" },
    ],
    diarizedSpeakers: [
      {
        id: "speaker-moving",
        sourceStreamIds: ["local-mic", "system-audio"],
        entityBindingId: "binding-moving",
        name: {
          displayName: "Dana",
          provenance: "voice_profile",
          confidence: 0.91,
        },
      },
    ],
    entityBindings: [
      {
        id: "binding-moving",
        diarizedSpeakerId: "speaker-moving",
        entityId: "entity-dana",
        status: "active",
        confidence: 0.91,
        provenance: "voice_profile",
      },
    ],
    transcriptSpans: [
      {
        id: "span-local",
        startMs: 0,
        endMs: 900,
        text: "local mic speech",
        words: [word("local", 0, 350)],
        speakerId: "speaker-moving",
        sourceStreamId: "local-mic",
      },
      {
        id: "span-system",
        startMs: 1000,
        endMs: 1800,
        text: "system audio speech",
        words: [word("system", 1000, 1350)],
        speakerId: "speaker-moving",
        sourceStreamId: "system-audio",
      },
    ],
  });

  return {
    googleMeetRoom,
    zoomPerParticipant,
    inPersonRoomMic,
    importedCorpus,
    oneSpeakerAcrossStreams,
  };
}
