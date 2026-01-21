import type {
  Availability,
  DayOfWeek,
  DomainMode,
  EngineState,
  FeedbackRaterBias,
  FeedbackSummary,
  Persona,
  PersonaId,
  PersonaStatus,
  ReliabilitySignals,
} from "@engine/types";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  creditLedgerTable,
  engineStateTable,
  getDatabase,
  personaMapTable,
  usersTable,
} from "@/lib/db";
import { readEnv } from "@/lib/env";
import {
  type CreditLedgerReason,
  listUsers,
  type UserRecord,
  type UserStatus,
} from "@/lib/store";

const ENGINE_STATE_ID = "primary";

const DOMAIN_LOOKUP: Record<DomainMode, true> = {
  general: true,
  business: true,
  dating: true,
  friendship: true,
};

const DEFAULT_TIME_ZONE = "America/New_York";
const DEFAULT_COUNTRY = "US";
const DEFAULT_DAYS: DayOfWeek[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

export type EngineStateRecord = {
  state: EngineState;
  cursor: number;
  lockedUntil: Date | null;
  lastRunAt: Date | null;
  lastRunDurationMs: number | null;
  updatedAt: Date;
};

export type EngineStateUpdate = {
  state: EngineState;
  cursor: number;
  lockedUntil?: Date | null;
  lastRunAt?: Date | null;
  lastRunDurationMs?: number | null;
};

export type PersonaSyncResult = {
  state: EngineState;
  personasUpserted: number;
  createdPersonaIds: number[];
};

export const createEmptyEngineState = (): EngineState => ({
  personas: [],
  matches: [],
  meetings: [],
  feedbackQueue: [],
  safetyReports: [],
  communities: [],
  credits: [],
  messages: [],
  matchGraph: { edges: [] },
});

const createDefaultAvailability = (timeZone: string): Availability => ({
  timeZone,
  weekly: DEFAULT_DAYS.map((day) => ({
    day,
    startMinutes: 9 * 60,
    endMinutes: 18 * 60,
  })),
  exceptions: [],
});

const createDefaultFeedbackSummary = (now: string): FeedbackSummary => ({
  sentimentScore: 0,
  positiveCount: 0,
  neutralCount: 0,
  negativeCount: 0,
  lastUpdated: now,
  redFlagTags: [],
  issueTags: [],
});

const createDefaultFeedbackBias = (now: string): FeedbackRaterBias => ({
  harshnessScore: 0,
  positivityBias: 0,
  redFlagFrequency: 0,
  notes: [],
  stats: {
    givenCount: 0,
    averageRating: 0,
    negativeRate: 0,
    redFlagRate: 0,
    lastUpdated: now,
  },
  lastUpdated: now,
});

const createDefaultReliability = (now: string): ReliabilitySignals => ({
  score: 0.6,
  lastUpdated: now,
  attendedCount: 0,
  lateCancelCount: 0,
  noShowCount: 0,
  ghostCount: 0,
  ghostedByOthersCount: 0,
  canceledOnByOthersCount: 0,
  responseLatencyAvgMinutes: 30,
  history: [],
});

const normalizeText = (value: string | null, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
};

const parseDomainList = (value: string | null): DomainMode[] => {
  if (!value) return [];
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.filter((token): token is DomainMode =>
    Object.hasOwn(DOMAIN_LOOKUP, token),
  );
};

const getDefaultDomains = (): DomainMode[] => {
  const raw =
    readEnv("SOULMATES_DEFAULT_DOMAINS") ?? readEnv("SOULMATES_MATCH_DOMAINS");
  const parsed = parseDomainList(raw);
  return parsed.length > 0 ? parsed : ["general"];
};

const mapUserStatus = (status: UserStatus): PersonaStatus => {
  switch (status) {
    case "active":
      return "active";
    case "blocked":
      return "blocked";
    default:
      return "pending";
  }
};

const createDefaultPersona = (
  personaId: PersonaId,
  name: string,
  city: string,
  timeZone: string,
  domains: DomainMode[],
  now: string,
): Persona => ({
  id: personaId,
  status: "pending",
  domains,
  general: {
    name,
    age: 25,
    genderIdentity: "prefer_not_say",
    pronouns: "they/them",
    location: {
      city,
      country: DEFAULT_COUNTRY,
      timeZone,
    },
    values: [],
    bio: "",
  },
  profile: {
    name,
    pronouns: "they/them",
    availability: createDefaultAvailability(timeZone),
    interests: [],
    meetingCadence: "flexible",
    connectionGoals: [],
    communityTags: [],
    feedbackSummary: createDefaultFeedbackSummary(now),
  },
  domainProfiles: {},
  matchPreferences: {
    blockedPersonaIds: [],
    excludedPersonaIds: [],
  },
  reliability: createDefaultReliability(now),
  feedbackBias: createDefaultFeedbackBias(now),
  facts: [],
  conversations: [],
  blockedPersonaIds: [],
  lastUpdated: now,
  profileRevision: 1,
});

const mergePersonaFromUser = (
  user: UserRecord,
  personaId: PersonaId,
  now: string,
  existing: Persona | null,
): Persona => {
  const defaultTimeZone =
    readEnv("SOULMATES_DEFAULT_TIME_ZONE") ?? DEFAULT_TIME_ZONE;
  const fallbackName = existing?.profile.name ?? `Member ${personaId}`;
  const fallbackCity = existing?.general.location.city ?? "Unknown";
  const name = normalizeText(user.name, fallbackName);
  const city = normalizeText(user.location, fallbackCity);
  const timeZone = existing?.profile.availability.timeZone ?? defaultTimeZone;
  const domains = existing?.domains ?? getDefaultDomains();
  const base =
    existing ??
    createDefaultPersona(personaId, name, city, timeZone, domains, now);
  const status = mapUserStatus(user.status);
  const availability =
    base.profile.availability ?? createDefaultAvailability(timeZone);

  const changed =
    base.status !== status ||
    base.general.name !== name ||
    base.general.location.city !== city ||
    base.profile.name !== name;

  return {
    ...base,
    status,
    general: {
      ...base.general,
      name,
      location: {
        ...base.general.location,
        city,
        timeZone,
      },
    },
    profile: {
      ...base.profile,
      name,
      availability,
    },
    lastUpdated: now,
    profileRevision: existing
      ? changed
        ? base.profileRevision + 1
        : base.profileRevision
      : 1,
  };
};

async function ensureEngineStateRow(): Promise<void> {
  const db = await getDatabase();
  await db
    .insert(engineStateTable)
    .values({
      id: ENGINE_STATE_ID,
      state: createEmptyEngineState(),
      cursor: 0,
    })
    .onConflictDoNothing();
}

export async function loadEngineState(): Promise<EngineStateRecord> {
  await ensureEngineStateRow();
  const db = await getDatabase();
  const [row] = await db
    .select()
    .from(engineStateTable)
    .where(eq(engineStateTable.id, ENGINE_STATE_ID))
    .limit(1);
  if (!row) {
    const now = new Date();
    return {
      state: createEmptyEngineState(),
      cursor: 0,
      lockedUntil: null,
      lastRunAt: null,
      lastRunDurationMs: null,
      updatedAt: now,
    };
  }
  return {
    state: row.state,
    cursor: row.cursor,
    lockedUntil: row.lockedUntil ?? null,
    lastRunAt: row.lastRunAt ?? null,
    lastRunDurationMs: row.lastRunDurationMs ?? null,
    updatedAt: row.updatedAt,
  };
}

export async function saveEngineState(
  update: EngineStateUpdate,
): Promise<void> {
  await ensureEngineStateRow();
  const db = await getDatabase();
  const now = new Date();
  await db
    .update(engineStateTable)
    .set({
      state: update.state,
      cursor: update.cursor,
      lockedUntil: update.lockedUntil ?? null,
      lastRunAt: update.lastRunAt ?? null,
      lastRunDurationMs: update.lastRunDurationMs ?? null,
      updatedAt: now,
    })
    .where(eq(engineStateTable.id, ENGINE_STATE_ID));
}

export async function acquireEngineLock(lockMs: number): Promise<boolean> {
  await ensureEngineStateRow();
  const db = await getDatabase();
  const now = new Date();
  const lockUntil = new Date(now.getTime() + Math.max(1, lockMs));
  const result = await db
    .update(engineStateTable)
    .set({ lockedUntil: lockUntil, updatedAt: now })
    .where(
      sql`${engineStateTable.id} = ${ENGINE_STATE_ID} AND (${engineStateTable.lockedUntil} IS NULL OR ${engineStateTable.lockedUntil} < ${now})`,
    )
    .returning();
  return result.length > 0;
}

export async function releaseEngineLock(): Promise<void> {
  const db = await getDatabase();
  await db
    .update(engineStateTable)
    .set({
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(engineStateTable.id, ENGINE_STATE_ID));
}

export async function getOrCreatePersonaIdForUser(
  userId: string,
): Promise<PersonaId> {
  const db = await getDatabase();
  const [existing] = await db
    .select()
    .from(personaMapTable)
    .where(eq(personaMapTable.userId, userId))
    .limit(1);
  if (existing) {
    return existing.personaId;
  }
  const [created] = await db
    .insert(personaMapTable)
    .values({ userId })
    .returning();
  return created.personaId;
}

export type PersonaUserLink = {
  personaId: PersonaId;
  userId: string;
  phone: string;
  name: string | null;
};

export async function getUsersByPersonaIds(
  personaIds: PersonaId[],
): Promise<PersonaUserLink[]> {
  if (personaIds.length === 0) return [];
  const db = await getDatabase();
  const rows = await db
    .select({
      personaId: personaMapTable.personaId,
      userId: personaMapTable.userId,
      phone: usersTable.phone,
      name: usersTable.name,
    })
    .from(personaMapTable)
    .innerJoin(usersTable, eq(personaMapTable.userId, usersTable.id))
    .where(inArray(personaMapTable.personaId, personaIds));
  return rows;
}

export async function getUserByPersonaId(
  personaId: PersonaId,
): Promise<PersonaUserLink | null> {
  const users = await getUsersByPersonaIds([personaId]);
  return users[0] ?? null;
}

export async function listPersonaIdsForSpendReason(
  reason: CreditLedgerReason,
  windowHours: number,
): Promise<PersonaId[]> {
  const db = await getDatabase();
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const rows = await db
    .select({ personaId: personaMapTable.personaId })
    .from(creditLedgerTable)
    .innerJoin(
      personaMapTable,
      eq(creditLedgerTable.userId, personaMapTable.userId),
    )
    .where(
      and(
        eq(creditLedgerTable.reason, reason),
        gte(creditLedgerTable.createdAt, cutoff),
      ),
    );
  const uniqueIds = new Set<PersonaId>(rows.map((row) => row.personaId));
  return [...uniqueIds];
}

export async function listPriorityPersonaIds(
  windowHours: number,
): Promise<PersonaId[]> {
  return listPersonaIdsForSpendReason("spend_priority_match", windowHours);
}

export async function listPrioritySchedulePersonaIds(
  windowHours: number,
): Promise<PersonaId[]> {
  return listPersonaIdsForSpendReason("spend_priority_schedule", windowHours);
}

export async function listFilterPersonaIds(
  windowHours: number,
): Promise<PersonaId[]> {
  return listPersonaIdsForSpendReason("spend_filters", windowHours);
}

export type PersonaBaseResult = {
  state: EngineState;
  persona: Persona;
  created: boolean;
};

export async function upsertPersonaBaseForUser(
  state: EngineState,
  user: UserRecord,
  now: string = new Date().toISOString(),
): Promise<PersonaBaseResult> {
  const personaId = await getOrCreatePersonaIdForUser(user.id);
  const existingIndex = state.personas.findIndex(
    (persona) => persona.id === personaId,
  );
  const existingPersona =
    existingIndex >= 0 ? state.personas[existingIndex] : null;
  const nextPersona = mergePersonaFromUser(
    user,
    personaId,
    now,
    existingPersona,
  );
  if (existingIndex >= 0) {
    state.personas[existingIndex] = nextPersona;
  } else {
    state.personas.push(nextPersona);
  }
  return { state, persona: nextPersona, created: existingIndex < 0 };
}

export async function syncPersonasFromUsers(
  state: EngineState,
): Promise<PersonaSyncResult> {
  const users = await listUsers();
  if (users.length === 0) {
    return { state, personasUpserted: 0, createdPersonaIds: [] };
  }

  const now = new Date().toISOString();
  const nextState = structuredClone(state);
  const personaIndex = new Map<PersonaId, number>();
  nextState.personas.forEach((persona: Persona, index: number) => {
    personaIndex.set(persona.id, index);
  });

  const createdPersonaIds: number[] = [];
  for (const user of users) {
    const personaId = await getOrCreatePersonaIdForUser(user.id);
    const existingIndex = personaIndex.get(personaId);
    const existingPersona =
      existingIndex === undefined ? null : nextState.personas[existingIndex];
    const nextPersona = mergePersonaFromUser(
      user,
      personaId,
      now,
      existingPersona,
    );

    if (existingIndex === undefined) {
      personaIndex.set(personaId, nextState.personas.length);
      nextState.personas.push(nextPersona);
      createdPersonaIds.push(personaId);
    } else {
      nextState.personas[existingIndex] = nextPersona;
    }
  }

  return {
    state: nextState,
    personasUpserted: users.length,
    createdPersonaIds,
  };
}
