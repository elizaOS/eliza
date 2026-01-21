import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
  parseBody,
  unauthorized,
} from "@/lib/api-utils";
import {
  applyMatchAction,
  listMatchesForPersona,
  type MatchAction,
} from "@/lib/engine-matches";
import {
  acquireEngineLock,
  getOrCreatePersonaIdForUser,
  loadEngineState,
  releaseEngineLock,
  saveEngineState,
} from "@/lib/engine-store";
import { readNumberEnv } from "@/lib/env";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchActionRequest = {
  matchId?: string;
  action?: MatchAction;
};

export async function GET() {
  const user = await requireSessionUser();
  if (!user) return unauthorized();

  const record = await loadEngineState();
  const personaId = await getOrCreatePersonaIdForUser(user.id);
  const matches = listMatchesForPersona(record.state, personaId);

  return ok(matches);
}

export async function POST(request: Request) {
  const user = await requireSessionUser();
  if (!user) return unauthorized();

  const body = (await parseBody<MatchActionRequest>(request)) ?? null;
  if (!body || !body.matchId || !body.action) {
    return badRequest("Missing matchId or action.");
  }
  if (body.action !== "accept" && body.action !== "decline") {
    return badRequest("Invalid action.");
  }

  const lockMs = readNumberEnv("SOULMATES_MATCH_ACTION_LOCK_MS", 15_000);
  const locked = await acquireEngineLock(lockMs);
  if (!locked) {
    return conflict("Matching engine is busy. Try again shortly.");
  }

  let saved = false;
  try {
    const record = await loadEngineState();
    const personaId = await getOrCreatePersonaIdForUser(user.id);
    const matchExists = record.state.matches.some(
      (match) => match.matchId === body.matchId,
    );
    if (!matchExists) {
      return notFound("Match not found.");
    }

    const updated = applyMatchAction(
      record.state,
      personaId,
      body.matchId,
      body.action,
    );
    if (!updated) {
      return forbidden();
    }

    await saveEngineState({
      state: record.state,
      cursor: record.cursor,
      lastRunAt: new Date(),
      lastRunDurationMs: null,
      lockedUntil: null,
    });
    saved = true;

    const matches = listMatchesForPersona(record.state, personaId);
    const summary = matches.find((match) => match.matchId === body.matchId);
    return ok(summary ?? updated);
  } catch (_err) {
    return badRequest("Failed to update match.");
  } finally {
    if (!saved) {
      await releaseEngineLock();
    }
  }
}
