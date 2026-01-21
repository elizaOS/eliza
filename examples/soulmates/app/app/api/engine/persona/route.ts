import {
  badRequest,
  conflict,
  ok,
  parseBody,
  serverError,
  unauthorized,
} from "@/lib/api-utils";
import {
  applyFlowPersonaUpdate,
  type FlowPersonaUpdate,
} from "@/lib/engine-persona";
import {
  acquireEngineLock,
  loadEngineState,
  releaseEngineLock,
  saveEngineState,
  upsertPersonaBaseForUser,
} from "@/lib/engine-store";
import { readEnv, readNumberEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/phone";
import { requireSessionUser } from "@/lib/session";
import {
  getUserById,
  type UserRecord,
  updateUserProfile,
  upsertUserByPhone,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PersonaIngestRequest = FlowPersonaUpdate & {
  userId?: string;
  phone?: string;
};

const getAuthSecret = (): string | null =>
  readEnv("SOULMATES_ENGINE_INGEST_SECRET");

const isAuthorized = (request: Request): boolean => {
  const secret = getAuthSecret();
  if (!secret) return false;
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const headerSecret = request.headers.get("x-engine-secret");
  return bearer === secret || headerSecret === secret;
};

const applyUserProfileUpdates = async (
  user: UserRecord,
  payload: PersonaIngestRequest,
): Promise<UserRecord> => {
  const name = payload.profile?.fullName?.trim() ?? null;
  const location = payload.profile?.city?.trim() ?? null;
  if (!name && !location) return user;
  const updated = await updateUserProfile(user.id, {
    name,
    location,
  });
  return updated ?? user;
};

export async function POST(request: Request) {
  const payload = (await parseBody<PersonaIngestRequest>(request)) ?? null;
  if (!payload) {
    return badRequest("Missing payload.");
  }

  const internalAuth = isAuthorized(request);
  let user: UserRecord | null = null;

  if (internalAuth) {
    if (payload.userId) {
      user = await getUserById(payload.userId);
      if (!user) return badRequest("User not found.");
      user = await applyUserProfileUpdates(user, payload);
    } else if (payload.phone) {
      const normalized = normalizePhone(payload.phone);
      if (!normalized) return badRequest("Invalid phone.");
      const name = payload.profile?.fullName?.trim() ?? null;
      const location = payload.profile?.city?.trim() ?? null;
      user = await upsertUserByPhone(normalized, { name, location });
    } else {
      return badRequest("Missing userId or phone.");
    }
  } else {
    const sessionUser = await requireSessionUser();
    if (!sessionUser) return unauthorized();
    user = await applyUserProfileUpdates(sessionUser, payload);
  }

  if (!user) {
    return badRequest("Unable to resolve user.");
  }

  const lockMs = readNumberEnv("SOULMATES_ENGINE_INGEST_LOCK_MS", 15_000);
  const locked = await acquireEngineLock(lockMs);
  if (!locked) {
    return conflict("Matching engine is busy. Try again shortly.");
  }

  let saved = false;
  try {
    const record = await loadEngineState();
    const now = new Date().toISOString();
    const base = await upsertPersonaBaseForUser(record.state, user, now);
    const updateResult = applyFlowPersonaUpdate(base.persona, payload, now);

    if (updateResult.changed) {
      const index = record.state.personas.findIndex(
        (persona) => persona.id === updateResult.persona.id,
      );
      if (index >= 0) {
        record.state.personas[index] = updateResult.persona;
      } else {
        record.state.personas.push(updateResult.persona);
      }
    }

    await saveEngineState({
      state: record.state,
      cursor: record.cursor,
      lastRunAt: new Date(),
      lastRunDurationMs: null,
      lockedUntil: null,
    });
    saved = true;

    return ok({
      personaId: updateResult.persona.id,
      status: updateResult.persona.status,
      domains: updateResult.persona.domains,
      changed: updateResult.changed,
    });
  } catch (_err) {
    return serverError("Failed to sync persona.");
  } finally {
    if (!saved) {
      await releaseEngineLock();
    }
  }
}
