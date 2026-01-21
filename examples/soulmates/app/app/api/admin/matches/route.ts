import { randomUUID } from "node:crypto";
import type {
  MatchRecord,
  MatchStatus,
  MeetingLocation,
  MeetingRecord,
  MeetingStatus,
} from "@engine/types";
import { badRequest, notFound, ok, unauthorized } from "@/lib/api-utils";
import {
  getUsersByPersonaIds,
  loadEngineState,
  saveEngineState,
} from "@/lib/engine-store";
import { requireAdminUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AdminMatchParticipant = {
  personaId: number;
  name: string;
  phone: string | null;
};

export type AdminMatchSummary = {
  matchId: string;
  domain: MatchRecord["domain"];
  status: MatchStatus;
  score: number;
  createdAt: string;
  personaA: AdminMatchParticipant;
  personaB: AdminMatchParticipant;
  meeting: MeetingRecord | null;
};

type MatchUpdateRequest = {
  matchId?: string;
  status?: MatchStatus;
  meetingStatus?: MeetingStatus;
  scheduledAt?: string;
  location?: MeetingLocation;
};

type AdminMatchPage = {
  items: AdminMatchSummary[];
  total: number;
  nextCursor: { createdAt: string; id: string } | null;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const parseCursor = (
  value: string | null,
): { createdAt: string; id: string } | null => {
  if (!value) return null;
  const [createdAt, id] = value.split("|");
  if (!createdAt || !id) return null;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return { createdAt: date.toISOString(), id };
};

const buildSummary = async (
  match: MatchRecord,
  meeting: MeetingRecord | null,
  userMap: Map<number, { phone: string; name: string | null }>,
): Promise<AdminMatchSummary> => {
  const userA = userMap.get(match.personaA);
  const userB = userMap.get(match.personaB);
  return {
    matchId: match.matchId,
    domain: match.domain,
    status: match.status,
    score: match.assessment.score,
    createdAt: match.createdAt,
    personaA: {
      personaId: match.personaA,
      name: userA?.name ?? "Unknown",
      phone: userA?.phone ?? null,
    },
    personaB: {
      personaId: match.personaB,
      name: userB?.name ?? "Unknown",
      phone: userB?.phone ?? null,
    },
    meeting,
  };
};

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return unauthorized();

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().toLowerCase() || "";
  const statusFilter = url.searchParams.get("status");
  const domainFilter = url.searchParams.get("domain");
  const createdAfter =
    url.searchParams.get("createdAfter") ?? url.searchParams.get("createdAt");
  const createdBefore = url.searchParams.get("createdBefore");
  const limitParam = url.searchParams.get("limit");
  const limit = clamp(Number.parseInt(limitParam ?? "50", 10), 1, 200);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const createdAfterTime = createdAfter ? Date.parse(createdAfter) : null;
  const createdBeforeTime = createdBefore ? Date.parse(createdBefore) : null;

  const record = await loadEngineState();
  const personaIds = Array.from(
    new Set(
      record.state.matches.flatMap((match) => [match.personaA, match.personaB]),
    ),
  );
  const users = await getUsersByPersonaIds(personaIds);
  const userMap = new Map<number, { phone: string; name: string | null }>();
  for (const user of users) {
    userMap.set(user.personaId, { phone: user.phone, name: user.name });
  }

  const summaries = await Promise.all(
    record.state.matches.map((match) => {
      const meeting = match.scheduledMeetingId
        ? (record.state.meetings.find(
            (entry) => entry.meetingId === match.scheduledMeetingId,
          ) ?? null)
        : null;
      return buildSummary(match, meeting, userMap);
    }),
  );

  const filtered = summaries.filter((summary) => {
    if (statusFilter && summary.status !== statusFilter) return false;
    if (domainFilter && summary.domain !== domainFilter) return false;
    if (createdAfterTime !== null && Number.isFinite(createdAfterTime)) {
      if (Date.parse(summary.createdAt) < createdAfterTime) return false;
    }
    if (createdBeforeTime !== null && Number.isFinite(createdBeforeTime)) {
      if (Date.parse(summary.createdAt) >= createdBeforeTime) return false;
    }
    if (q) {
      const haystack = [
        summary.matchId,
        summary.domain,
        summary.personaA.name,
        summary.personaA.phone ?? "",
        summary.personaB.name,
        summary.personaB.phone ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const sorted = filtered.sort((a, b) => {
    const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return a.matchId < b.matchId ? 1 : -1;
  });

  const cursorTime = cursor ? Date.parse(cursor.createdAt) : null;
  const windowed = sorted.filter((item) => {
    if (!cursor || cursorTime === null || !Number.isFinite(cursorTime))
      return true;
    const itemTime = Date.parse(item.createdAt);
    if (itemTime < cursorTime) return true;
    if (itemTime === cursorTime && item.matchId < cursor.id) return true;
    return false;
  });

  const items = windowed.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === limit && last
      ? { createdAt: last.createdAt, id: last.matchId }
      : null;

  const payload: AdminMatchPage = {
    items,
    total: filtered.length,
    nextCursor,
  };

  return ok(payload);
}

export async function POST(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return unauthorized();

  const body = (await request.json()) as MatchUpdateRequest | null;
  if (!body?.matchId) {
    return badRequest("Missing matchId.");
  }

  const record = await loadEngineState();
  const match = record.state.matches.find(
    (entry) => entry.matchId === body.matchId,
  );
  if (!match) return notFound("Match not found.");

  if (body.status) {
    match.status = body.status;
  }

  let meeting = match.scheduledMeetingId
    ? record.state.meetings.find(
        (entry) => entry.meetingId === match.scheduledMeetingId,
      )
    : undefined;

  if (body.scheduledAt) {
    if (!meeting) {
      meeting = {
        meetingId: randomUUID(),
        matchId: match.matchId,
        scheduledAt: body.scheduledAt,
        location: body.location ?? {
          name: "TBD",
          address: "TBD",
          city: "TBD",
        },
        status: "scheduled",
        rescheduleCount: 0,
      };
      record.state.meetings.push(meeting);
      match.scheduledMeetingId = meeting.meetingId;
      match.status = "scheduled";
    } else {
      meeting.scheduledAt = body.scheduledAt;
      if (body.location) {
        meeting.location = body.location;
      }
    }
  }

  if (body.meetingStatus && meeting) {
    meeting.status = body.meetingStatus;
  }

  await saveEngineState({
    state: record.state,
    cursor: record.cursor,
    lastRunAt: new Date(),
    lastRunDurationMs: null,
    lockedUntil: null,
  });

  const personaIds = [match.personaA, match.personaB];
  const users = await getUsersByPersonaIds(personaIds);
  const userMap = new Map<number, { phone: string; name: string | null }>();
  for (const user of users) {
    userMap.set(user.personaId, { phone: user.phone, name: user.name });
  }

  const summary = await buildSummary(match, meeting ?? null, userMap);
  return ok(summary);
}
