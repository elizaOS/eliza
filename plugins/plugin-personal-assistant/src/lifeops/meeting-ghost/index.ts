/**
 * Transcript-side producer for meetings the owner skipped.
 *
 * Given a finalized, diarized meeting transcript (the canonical
 * `TranscriptSegment[]` that `@elizaos/plugin-meetings`' pipeline `finalize()`
 * produces) plus owner context, this module derives the deterministic
 * post-meeting shape LifeOps acts on: decisions, care-about hits, extracted
 * commitments, commitment-ledger rows, a short digest, and — the part that
 * leaves the module — owner-approval requests as `ApprovalEnqueueInput[]` that
 * feed `ApprovalQueue.enqueue()` directly (no re-mapping at the call site). The
 * scheduled-task consumer that runs this on a real transcript and routes the
 * side effects lives in `./consumer.ts`.
 *
 * It is deliberately pure so tests can pin care-about filtering and commitment
 * extraction against a realistic diarized fixture without mocking connectors.
 * Extraction is heuristic (regex over natural utterances); a model-driven pass
 * is out of scope here (tracked by #14870 for ASR that these rules miss).
 */

import type { TranscriptSegment } from "@elizaos/shared";
import type {
  ApprovalEnqueueInput,
  ApprovalPayload,
} from "../approval-queue.types.js";
import type { LifeOpsCommitmentLedgerRecord } from "../commitments/index.js";
import { createLifeOpsCommitmentLedgerRecord } from "../commitments/index.js";

export interface MeetingGhostAttendee {
  readonly name: string;
  readonly email?: string;
}

/** Meeting metadata wrapping the canonical diarized segments. */
export interface MeetingGhostTranscript {
  readonly meetingId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly attendees: readonly MeetingGhostAttendee[];
  readonly segments: readonly TranscriptSegment[];
}

export interface MeetingGhostOwnerContext {
  readonly ownerUserId: string;
  readonly ownerDisplayName: string;
  readonly requestedBy: string;
  readonly careAbouts: readonly string[];
  readonly calendarId?: string;
  readonly approvalExpiresAt: Date;
}

export interface MeetingGhostDecision {
  readonly id: string;
  readonly text: string;
  readonly speaker: string;
  readonly sourceOffsetMs: number | null;
}

export interface MeetingGhostCommitment {
  readonly id: string;
  readonly who: string;
  readonly recipientEmail: string | null;
  readonly what: string;
  readonly dueText: string | null;
  readonly dueDate: string | null;
  readonly sourceText: string;
  readonly sourceOffsetMs: number | null;
}

export interface MeetingGhostCareHit {
  readonly id: string;
  readonly careAbout: string;
  readonly speaker: string;
  readonly text: string;
  readonly sourceOffsetMs: number | null;
}

/** A calendar-deadline approval bound back to the commitment that produced it. */
export interface MeetingGhostCalendarIntent {
  readonly commitmentId: string;
  readonly approval: ApprovalEnqueueInput;
}

export interface MeetingGhostAnalysis {
  readonly meetingId: string;
  readonly decisions: readonly MeetingGhostDecision[];
  readonly commitments: readonly MeetingGhostCommitment[];
  readonly commitmentLedgerRecords: readonly LifeOpsCommitmentLedgerRecord[];
  readonly careHits: readonly MeetingGhostCareHit[];
  /** Ready to feed `ApprovalQueue.enqueue()` directly. */
  readonly followUpApprovals: readonly ApprovalEnqueueInput[];
  readonly calendarIntents: readonly MeetingGhostCalendarIntent[];
  readonly digestLines: readonly string[];
}

// A diarized commitment reads as a natural utterance, so the extractor keys on
// the speaker + a commitment verb ("will send the plan by Friday"), not on a
// literal "Action:" prefix a human would never say aloud. The prefixed forms
// are still accepted for transcripts that carry structured annotations.
const DECISION_PREFIX_RE =
  /^(?:decision|decided|we decided|decision is)\s*[:-]\s*(.+)$/i;
// A leading "we/the team decided (to)? X" spoken sentence.
const SPOKEN_DECISION_RE =
  /^(?:we|the team|everyone|the group)\s+(?:agreed|decided|settled|concluded)\s+(?:that\s+|to\s+|on\s+)?(?<body>.+?)[.;]?$/i;
const COMMITMENT_PREFIX_RE =
  /^(?:action|commitment|follow-up)\s*[:-]\s*(?<body>.+)$/i;
// "Mira will send the deck by Friday" / "Ben is taking the calendar update"
const NAMED_COMMITMENT_RE =
  /^(?<who>[A-Z][A-Za-z .'-]{1,60}?)\s+(?:will|to|owns|is taking|committed to|is going to|can)\s+(?<what>.+?)(?:\s+by\s+(?<due>[^.;]+))?[.;]?$/;
// First-person, who = the speaker. Requires an explicit commitment verb
// ("I will…", "I'll…", "we can…", "I am going to…") so a bare first-person
// remark ("I think…") is not mistaken for an action item.
const SPEAKER_COMMITMENT_RE =
  /^(?:i|we)\s*(?:'ll\s+|will\s+|can\s+|am going to\s+|are going to\s+)(?<what>.+?)(?:\s+by\s+(?<due>[^.;]+))?[.;]?$/i;

const WEEKDAYS = new Map([
  ["sunday", 0],
  ["monday", 1],
  ["tuesday", 2],
  ["wednesday", 3],
  ["thursday", 4],
  ["friday", 5],
  ["saturday", 6],
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stableId(parts: readonly string[]): string {
  return parts
    .map((part) => normalize(part).replace(/\s+/g, "-"))
    .filter(Boolean)
    .join(":");
}

/** Speaker label for a diarized segment; falls back to the entity id. */
function speakerOf(segment: TranscriptSegment): string {
  return segment.speakerLabel ?? segment.speakerEntityId ?? "Unknown";
}

function careAboutMatches(text: string, careAbout: string): boolean {
  const normalizedText = normalize(text);
  const normalizedCare = normalize(careAbout);
  if (!normalizedCare) return false;
  const tokens = normalizedCare.split(" ").filter((token) => token.length > 2);
  if (tokens.length === 0) return false;
  if (normalizedText.includes(normalizedCare)) return true;
  return tokens.every((token) => normalizedText.includes(token));
}

function findAttendeeEmail(
  attendees: readonly MeetingGhostAttendee[],
  name: string,
): string | null {
  const normalizedName = normalize(name);
  const attendee = attendees.find((entry) => {
    const attendeeName = normalize(entry.name);
    return (
      attendeeName === normalizedName ||
      attendeeName.includes(normalizedName) ||
      normalizedName.includes(attendeeName)
    );
  });
  return attendee?.email ?? null;
}

function parseDecision(
  segment: TranscriptSegment,
  index: number,
): MeetingGhostDecision | null {
  const text = compact(segment.text);
  const decision =
    text.match(DECISION_PREFIX_RE)?.[1] ??
    text.match(SPOKEN_DECISION_RE)?.groups?.body ??
    null;
  const compacted = decision ? compact(decision) : "";
  if (!compacted) return null;
  return {
    id: stableId(["decision", String(index), compacted]),
    text: compacted,
    speaker: speakerOf(segment),
    sourceOffsetMs: segment.startMs,
  };
}

function parseCommitmentBody(text: string): {
  who: string | null;
  what: string;
  dueText: string | null;
} | null {
  const body = text.match(COMMITMENT_PREFIX_RE)?.groups?.body ?? text;
  const named = compact(body).match(NAMED_COMMITMENT_RE);
  if (named?.groups?.what) {
    return {
      who: compact(named.groups.who ?? ""),
      what: compact(named.groups.what),
      dueText: named.groups.due ? compact(named.groups.due) : null,
    };
  }
  const speaker = compact(body).match(SPEAKER_COMMITMENT_RE);
  if (speaker?.groups?.what) {
    return {
      who: null,
      what: compact(speaker.groups.what),
      dueText: speaker.groups.due ? compact(speaker.groups.due) : null,
    };
  }
  return null;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDueDate(
  dueText: string | null,
  meetingStartedAt: string,
): string | null {
  if (!dueText) return null;
  const trimmed = dueText.trim();
  const explicit = trimmed.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (explicit?.[1]) return explicit[1];

  const base = new Date(meetingStartedAt);
  if (Number.isNaN(base.getTime())) return null;
  const normalizedDue = normalize(trimmed);
  if (normalizedDue.includes("tomorrow")) return toIsoDate(addDays(base, 1));

  const weekday = [...WEEKDAYS.entries()].find(([name]) =>
    normalizedDue.includes(name),
  );
  if (weekday) {
    const [, target] = weekday;
    const current = base.getUTCDay();
    const delta = (target - current + 7) % 7 || 7;
    return toIsoDate(addDays(base, delta));
  }
  return null;
}

function dueDateToLedgerDueAt(dueDate: string | null): string | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T17:00:00.000Z`);
  return Number.isNaN(due.getTime()) ? null : due.toISOString();
}

function parseCommitment(
  transcript: MeetingGhostTranscript,
  segment: TranscriptSegment,
  index: number,
): MeetingGhostCommitment | null {
  const text = compact(segment.text);
  const parsed = parseCommitmentBody(text);
  if (!parsed) return null;
  const who = parsed.who ?? speakerOf(segment);
  const dueDate = parseDueDate(parsed.dueText, transcript.startedAt);
  return {
    id: stableId(["commitment", String(index), who, parsed.what]),
    who,
    recipientEmail: findAttendeeEmail(transcript.attendees, who),
    what: parsed.what,
    dueText: parsed.dueText,
    dueDate,
    sourceText: text,
    sourceOffsetMs: segment.startMs,
  };
}

function buildFollowUpApproval(
  transcript: MeetingGhostTranscript,
  owner: MeetingGhostOwnerContext,
  commitment: MeetingGhostCommitment,
): ApprovalEnqueueInput | null {
  if (!commitment.recipientEmail) return null;
  const subject = `Follow-up from ${transcript.title}`;
  const due = commitment.dueText ? ` by ${commitment.dueText}` : "";
  const payload: ApprovalPayload = {
    action: "send_email",
    to: [commitment.recipientEmail],
    cc: [],
    bcc: [],
    subject,
    body: `${commitment.who},\n\nFollowing up from ${transcript.title}: please ${commitment.what}${due}.\n\n${owner.ownerDisplayName}`,
    threadId: null,
    replyToMessageId: null,
  };
  return {
    requestedBy: owner.requestedBy,
    subjectUserId: owner.ownerUserId,
    action: "send_email",
    channel: "email",
    reason: `Queue owner-approved follow-up for ${commitment.who} from ${transcript.title}`,
    expiresAt: owner.approvalExpiresAt,
    payload,
  };
}

function buildCalendarIntent(
  transcript: MeetingGhostTranscript,
  owner: MeetingGhostOwnerContext,
  commitment: MeetingGhostCommitment,
): MeetingGhostCalendarIntent | null {
  if (!commitment.recipientEmail || !commitment.dueDate || !owner.calendarId) {
    return null;
  }
  const startsAtMs = Date.parse(`${commitment.dueDate}T09:00:00.000Z`);
  if (Number.isNaN(startsAtMs)) return null;
  const payload: ApprovalPayload = {
    action: "schedule_event",
    calendarId: owner.calendarId,
    title: `Deadline: ${commitment.what}`,
    startsAtMs,
    endsAtMs: startsAtMs + 30 * 60 * 1000,
    attendees: [commitment.recipientEmail],
    location: null,
    description: `Commitment from ${transcript.title}: ${commitment.sourceText}`,
  };
  return {
    commitmentId: commitment.id,
    approval: {
      requestedBy: owner.requestedBy,
      subjectUserId: owner.ownerUserId,
      action: "schedule_event",
      channel: "google_calendar",
      reason: `Place deadline for ${commitment.who}'s commitment from ${transcript.title}`,
      expiresAt: owner.approvalExpiresAt,
      payload,
    },
  };
}

function buildDigestLines(
  decisions: readonly MeetingGhostDecision[],
  careHits: readonly MeetingGhostCareHit[],
  commitments: readonly MeetingGhostCommitment[],
): string[] {
  const lines: string[] = [];
  for (const decision of decisions) {
    lines.push(`Decision: ${decision.text}`);
  }
  for (const hit of careHits) {
    lines.push(`Care-about hit (${hit.careAbout}): ${hit.text}`);
  }
  for (const commitment of commitments) {
    const due = commitment.dueText ? ` by ${commitment.dueText}` : "";
    lines.push(`Commitment: ${commitment.who} -> ${commitment.what}${due}`);
  }
  return lines.slice(0, 3);
}

export function createMeetingGhostCommitmentLedgerRecord(input: {
  readonly agentId: string;
  readonly transcript: MeetingGhostTranscript;
  readonly commitment: MeetingGhostCommitment;
}): LifeOpsCommitmentLedgerRecord {
  return createLifeOpsCommitmentLedgerRecord({
    agentId: input.agentId,
    source: "transcript",
    sourceKey: `${input.transcript.meetingId}:${input.commitment.id}`,
    kind: "commitment",
    summary: input.commitment.what,
    counterparty: input.commitment.who,
    dueAt: dueDateToLedgerDueAt(input.commitment.dueDate),
    confidence: input.commitment.dueDate ? 0.86 : 0.78,
    metadata: {
      meetingId: input.transcript.meetingId,
      meetingTitle: input.transcript.title,
      meetingStartedAt: input.transcript.startedAt,
      commitmentId: input.commitment.id,
      sourceText: input.commitment.sourceText,
      sourceOffsetMs: input.commitment.sourceOffsetMs,
      dueText: input.commitment.dueText,
      recipientEmail: input.commitment.recipientEmail,
    },
    createdAt: input.transcript.startedAt,
    updatedAt: input.transcript.startedAt,
  });
}

export function analyzeMeetingGhostTranscript(input: {
  readonly agentId?: string;
  readonly transcript: MeetingGhostTranscript;
  readonly owner: MeetingGhostOwnerContext;
}): MeetingGhostAnalysis {
  const decisions: MeetingGhostDecision[] = [];
  const commitments: MeetingGhostCommitment[] = [];
  const careHits: MeetingGhostCareHit[] = [];

  input.transcript.segments.forEach((segment, index) => {
    const decision = parseDecision(segment, index);
    if (decision) decisions.push(decision);

    // A group decision ("We decided to…", "The team agreed to…") is not an
    // individual's action item — skip commitment extraction on the same
    // segment so a collective verb never becomes a per-person follow-up.
    const commitment = decision
      ? null
      : parseCommitment(input.transcript, segment, index);
    if (commitment) commitments.push(commitment);

    for (const careAbout of input.owner.careAbouts) {
      if (careAboutMatches(segment.text, careAbout)) {
        careHits.push({
          id: stableId(["care", String(index), careAbout]),
          careAbout,
          speaker: speakerOf(segment),
          text: compact(segment.text),
          sourceOffsetMs: segment.startMs,
        });
      }
    }
  });

  const followUpApprovals = commitments
    .map((commitment) =>
      buildFollowUpApproval(input.transcript, input.owner, commitment),
    )
    .filter((entry): entry is ApprovalEnqueueInput => entry !== null);
  const calendarIntents = commitments
    .map((commitment) =>
      buildCalendarIntent(input.transcript, input.owner, commitment),
    )
    .filter((entry): entry is MeetingGhostCalendarIntent => entry !== null);
  const commitmentLedgerRecords = input.agentId
    ? commitments.map((commitment) =>
        createMeetingGhostCommitmentLedgerRecord({
          agentId: input.agentId,
          transcript: input.transcript,
          commitment,
        }),
      )
    : [];

  return {
    meetingId: input.transcript.meetingId,
    decisions,
    commitments,
    commitmentLedgerRecords,
    careHits,
    followUpApprovals,
    calendarIntents,
    digestLines: buildDigestLines(decisions, careHits, commitments),
  };
}
