/**
 * Transcript-side producer for meetings the owner skipped.
 *
 * The live meeting joiner and diarization path can hand this module a normalized
 * transcript; this code owns the deterministic post-meeting shape that LifeOps
 * needs before it writes ledger rows, queues owner-approved follow-ups, or
 * creates calendar deadline intents. It is deliberately pure so tests can pin
 * care-about filtering and commitment extraction without mocking connectors.
 */

export interface MeetingGhostAttendee {
  readonly name: string;
  readonly email?: string;
}

export interface MeetingGhostTranscriptSegment {
  readonly speaker: string;
  readonly text: string;
  readonly offsetMs?: number;
}

export interface MeetingGhostTranscript {
  readonly meetingId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly attendees: readonly MeetingGhostAttendee[];
  readonly segments: readonly MeetingGhostTranscriptSegment[];
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

export type MeetingGhostApprovalIntent =
  | {
      readonly requestedBy: string;
      readonly subjectUserId: string;
      readonly action: "send_email";
      readonly channel: "email";
      readonly reason: string;
      readonly expiresAt: Date;
      readonly payload: {
        readonly action: "send_email";
        readonly to: readonly string[];
        readonly cc: readonly string[];
        readonly bcc: readonly string[];
        readonly subject: string;
        readonly body: string;
        readonly threadId: string | null;
        readonly replyToMessageId: string | null;
      };
    }
  | {
      readonly requestedBy: string;
      readonly subjectUserId: string;
      readonly action: "schedule_event";
      readonly channel: "google_calendar";
      readonly reason: string;
      readonly expiresAt: Date;
      readonly payload: {
        readonly action: "schedule_event";
        readonly calendarId: string;
        readonly title: string;
        readonly startsAtMs: number;
        readonly endsAtMs: number;
        readonly attendees: readonly string[];
        readonly location: string | null;
        readonly description: string | null;
      };
    };

export interface MeetingGhostCalendarIntent {
  readonly commitmentId: string;
  readonly approval: MeetingGhostApprovalIntent;
}

export interface MeetingGhostAnalysis {
  readonly meetingId: string;
  readonly decisions: readonly MeetingGhostDecision[];
  readonly commitments: readonly MeetingGhostCommitment[];
  readonly careHits: readonly MeetingGhostCareHit[];
  readonly followUpApprovals: readonly MeetingGhostApprovalIntent[];
  readonly calendarIntents: readonly MeetingGhostCalendarIntent[];
  readonly digestLines: readonly string[];
}

const DECISION_PREFIX_RE =
  /^(?:decision|decided|we decided|decision is)\s*[:-]\s*(.+)$/i;
const COMMITMENT_PREFIX_RE =
  /^(?:action|commitment|follow-up)\s*[:-]\s*(?<body>.+)$/i;
const NAMED_COMMITMENT_RE =
  /^(?<who>[A-Z][A-Za-z .'-]{1,60}?)\s+(?:will|to|owns|is taking|committed to)\s+(?<what>.+?)(?:\s+by\s+(?<due>[^.;]+))?[.;]?$/;
const SPEAKER_COMMITMENT_RE =
  /^(?:i|we)\s+(?:will|can|am going to|are going to)\s+(?<what>.+?)(?:\s+by\s+(?<due>[^.;]+))?[.;]?$/i;

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

function stripSpeakerPrefix(text: string): string {
  const trimmed = compact(text);
  const match = trimmed.match(/^[A-Z][A-Za-z .'-]{1,60}:\s*(.+)$/);
  if (
    match &&
    /^(?:action|commitment|decision|decided|follow-up)$/i.test(
      trimmed.slice(0, trimmed.indexOf(":")).trim(),
    )
  ) {
    return trimmed;
  }
  return match?.[1] ? compact(match[1]) : trimmed;
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
  segment: MeetingGhostTranscriptSegment,
  index: number,
): MeetingGhostDecision | null {
  const text = stripSpeakerPrefix(segment.text);
  const match = text.match(DECISION_PREFIX_RE);
  if (!match?.[1]) return null;
  const decision = compact(match[1]);
  if (!decision) return null;
  return {
    id: stableId(["decision", String(index), decision]),
    text: decision,
    speaker: segment.speaker,
    sourceOffsetMs: segment.offsetMs ?? null,
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

function parseCommitment(
  transcript: MeetingGhostTranscript,
  segment: MeetingGhostTranscriptSegment,
  index: number,
): MeetingGhostCommitment | null {
  const text = stripSpeakerPrefix(segment.text);
  const parsed = parseCommitmentBody(text);
  if (!parsed) return null;
  const who = parsed.who ?? segment.speaker;
  const dueDate = parseDueDate(parsed.dueText, transcript.startedAt);
  return {
    id: stableId(["commitment", String(index), who, parsed.what]),
    who,
    recipientEmail: findAttendeeEmail(transcript.attendees, who),
    what: parsed.what,
    dueText: parsed.dueText,
    dueDate,
    sourceText: text,
    sourceOffsetMs: segment.offsetMs ?? null,
  };
}

function buildFollowUpApproval(
  transcript: MeetingGhostTranscript,
  owner: MeetingGhostOwnerContext,
  commitment: MeetingGhostCommitment,
): MeetingGhostApprovalIntent | null {
  if (!commitment.recipientEmail) return null;
  const subject = `Follow-up from ${transcript.title}`;
  const due = commitment.dueText ? ` by ${commitment.dueText}` : "";
  return {
    requestedBy: owner.requestedBy,
    subjectUserId: owner.ownerUserId,
    action: "send_email",
    channel: "email",
    reason: `Queue owner-approved follow-up for ${commitment.who} from ${transcript.title}`,
    expiresAt: owner.approvalExpiresAt,
    payload: {
      action: "send_email",
      to: [commitment.recipientEmail],
      cc: [],
      bcc: [],
      subject,
      body: `${commitment.who},\n\nFollowing up from ${transcript.title}: please ${commitment.what}${due}.\n\n${owner.ownerDisplayName}`,
      threadId: null,
      replyToMessageId: null,
    },
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
  return {
    commitmentId: commitment.id,
    approval: {
      requestedBy: owner.requestedBy,
      subjectUserId: owner.ownerUserId,
      action: "schedule_event",
      channel: "google_calendar",
      reason: `Place deadline for ${commitment.who}'s commitment from ${transcript.title}`,
      expiresAt: owner.approvalExpiresAt,
      payload: {
        action: "schedule_event",
        calendarId: owner.calendarId,
        title: `Deadline: ${commitment.what}`,
        startsAtMs,
        endsAtMs: startsAtMs + 30 * 60 * 1000,
        attendees: [commitment.recipientEmail],
        location: null,
        description: `Commitment from ${transcript.title}: ${commitment.sourceText}`,
      },
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

export function analyzeMeetingGhostTranscript(input: {
  readonly transcript: MeetingGhostTranscript;
  readonly owner: MeetingGhostOwnerContext;
}): MeetingGhostAnalysis {
  const decisions: MeetingGhostDecision[] = [];
  const commitments: MeetingGhostCommitment[] = [];
  const careHits: MeetingGhostCareHit[] = [];

  input.transcript.segments.forEach((segment, index) => {
    const decision = parseDecision(segment, index);
    if (decision) decisions.push(decision);

    const commitment = parseCommitment(input.transcript, segment, index);
    if (commitment) commitments.push(commitment);

    for (const careAbout of input.owner.careAbouts) {
      if (careAboutMatches(segment.text, careAbout)) {
        careHits.push({
          id: stableId(["care", String(index), careAbout]),
          careAbout,
          speaker: segment.speaker,
          text: stripSpeakerPrefix(segment.text),
          sourceOffsetMs: segment.offsetMs ?? null,
        });
      }
    }
  });

  const followUpApprovals = commitments
    .map((commitment) =>
      buildFollowUpApproval(input.transcript, input.owner, commitment),
    )
    .filter((entry): entry is MeetingGhostApprovalIntent => entry !== null);
  const calendarIntents = commitments
    .map((commitment) =>
      buildCalendarIntent(input.transcript, input.owner, commitment),
    )
    .filter((entry): entry is MeetingGhostCalendarIntent => entry !== null);

  return {
    meetingId: input.transcript.meetingId,
    decisions,
    commitments,
    careHits,
    followUpApprovals,
    calendarIntents,
    digestLines: buildDigestLines(decisions, careHits, commitments),
  };
}
