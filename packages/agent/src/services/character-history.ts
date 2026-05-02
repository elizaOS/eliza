import { type IAgentRuntime, type Memory, MemoryType } from "@elizaos/core";

export const CHARACTER_HISTORY_TABLE = "character_modifications";
export const MAX_CHARACTER_HISTORY_LIMIT = 100;

export type RuntimeCharacterLike = {
  name?: string;
  username?: string;
  bio?: string | string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  postExamples?: string[];
  messageExamples?: unknown;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CharacterHistorySource = "manual" | "agent" | "restore";

type CharacterHistoryValue =
  | string
  | number
  | boolean
  | null
  | CharacterHistoryValue[]
  | { [key: string]: CharacterHistoryValue | undefined };

export type CharacterHistorySnapshot = {
  name?: string;
  username?: string;
  bio?: string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  postExamples?: string[];
  messageExamples?: CharacterHistoryValue[];
};

export type CharacterHistoryField = keyof CharacterHistorySnapshot;

export type CharacterHistoryChange = {
  field: CharacterHistoryField;
  before?: CharacterHistoryValue;
  after?: CharacterHistoryValue;
};

export type CharacterHistoryEntry = {
  id?: string;
  timestamp: number;
  source: CharacterHistorySource;
  summary: string;
  fieldsChanged: CharacterHistoryField[];
  changes: CharacterHistoryChange[];
  before: CharacterHistorySnapshot;
  after: CharacterHistorySnapshot;
};

type CharacterHistoryRecordParams = {
  previousCharacter?: RuntimeCharacterLike | null;
  nextCharacter: RuntimeCharacterLike;
  source: CharacterHistorySource;
  timestamp?: number;
  roomId?: string;
};

const CHARACTER_HISTORY_FIELDS = [
  "name",
  "username",
  "bio",
  "system",
  "adjectives",
  "topics",
  "style",
  "messageExamples",
  "postExamples",
] as const satisfies readonly CharacterHistoryField[];

const CHARACTER_HISTORY_FIELD_LABELS: Record<CharacterHistoryField, string> = {
  name: "name",
  username: "username",
  bio: "bio",
  system: "system prompt",
  adjectives: "adjectives",
  topics: "topics",
  style: "style",
  messageExamples: "message examples",
  postExamples: "post examples",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneIfDefined<T>(value: T): T {
  return value === undefined ? value : cloneJson(value);
}

function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForCompare(entry));
  }
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeForCompare(value[key]);
    }
    return normalized;
  }
  return value;
}

function areEqualForHistory(previous: unknown, next: unknown): boolean {
  return (
    JSON.stringify(normalizeForCompare(previous)) ===
    JSON.stringify(normalizeForCompare(next))
  );
}

function hasOwnField(
  snapshot: CharacterHistorySnapshot,
  field: CharacterHistoryField,
): boolean {
  return Object.hasOwn(snapshot, field);
}

function coerceHistorySource(value: unknown): CharacterHistorySource {
  return value === "manual" || value === "agent" || value === "restore"
    ? value
    : "agent";
}

function buildHistorySummary(
  source: CharacterHistorySource,
  fieldsChanged: CharacterHistoryField[],
): string {
  const sourceLabel =
    source === "manual"
      ? "Manual edit"
      : source === "restore"
        ? "Restore"
        : "Agent update";
  const fieldLabels = fieldsChanged.map(
    (field) => CHARACTER_HISTORY_FIELD_LABELS[field],
  );

  if (fieldLabels.length === 0) {
    return `${sourceLabel} saved`;
  }
  if (fieldLabels.length === 1) {
    return `${sourceLabel} changed ${fieldLabels[0]}`;
  }
  return `${sourceLabel} changed ${fieldLabels.join(", ")}`;
}

function toCharacterHistoryValue(
  value: unknown,
): CharacterHistoryValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value as string | boolean | null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value.map(
      (entry) => toCharacterHistoryValue(entry) ?? null,
    ) as CharacterHistoryValue[];
  }
  if (isRecord(value)) {
    const normalized: Record<string, CharacterHistoryValue | undefined> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedEntry = toCharacterHistoryValue(entry);
      if (normalizedEntry !== undefined) {
        normalized[key] = normalizedEntry;
      }
    }
    return normalized;
  }
  return undefined;
}

export function buildCharacterHistorySnapshot(
  character: RuntimeCharacterLike,
): CharacterHistorySnapshot {
  const snapshot: CharacterHistorySnapshot = {};

  if (typeof character.name === "string" && character.name.trim()) {
    snapshot.name = character.name.trim();
  }
  if (typeof character.username === "string" && character.username.trim()) {
    snapshot.username = character.username.trim();
  }
  if (Array.isArray(character.bio)) {
    snapshot.bio = [...character.bio];
  } else if (typeof character.bio === "string" && character.bio.trim()) {
    snapshot.bio = [character.bio];
  }
  if (typeof character.system === "string") {
    snapshot.system = character.system;
  }
  if (Array.isArray(character.adjectives)) {
    snapshot.adjectives = [...character.adjectives];
  }
  if (Array.isArray(character.topics)) {
    snapshot.topics = [...character.topics];
  }
  if (character.style) {
    const style = {
      ...(Array.isArray(character.style.all)
        ? { all: [...character.style.all] }
        : {}),
      ...(Array.isArray(character.style.chat)
        ? { chat: [...character.style.chat] }
        : {}),
      ...(Array.isArray(character.style.post)
        ? { post: [...character.style.post] }
        : {}),
    };
    if (Object.keys(style).length > 0) {
      snapshot.style = style;
    }
  }
  if (Array.isArray(character.messageExamples)) {
    const messageExamples = toCharacterHistoryValue(character.messageExamples);
    if (Array.isArray(messageExamples)) {
      snapshot.messageExamples = messageExamples;
    }
  }
  if (Array.isArray(character.postExamples)) {
    snapshot.postExamples = [...character.postExamples];
  }

  return snapshot;
}

export function diffCharacterHistorySnapshots(
  previous: CharacterHistorySnapshot,
  next: CharacterHistorySnapshot,
): CharacterHistoryChange[] {
  const changes: CharacterHistoryChange[] = [];

  for (const field of CHARACTER_HISTORY_FIELDS) {
    const previousHasField = hasOwnField(previous, field);
    const nextHasField = hasOwnField(next, field);
    const previousValue = previous[field];
    const nextValue = next[field];

    if (!previousHasField && !nextHasField) {
      continue;
    }
    if (areEqualForHistory(previousValue, nextValue)) {
      continue;
    }

    changes.push({
      field,
      ...(previousHasField ? { before: cloneIfDefined(previousValue) } : {}),
      ...(nextHasField ? { after: cloneIfDefined(nextValue) } : {}),
    });
  }

  return changes;
}

export async function recordCharacterHistory(
  runtime: IAgentRuntime,
  params: CharacterHistoryRecordParams,
): Promise<CharacterHistoryEntry | null> {
  const previousSnapshot = buildCharacterHistorySnapshot(
    params.previousCharacter ?? {},
  );
  const nextSnapshot = buildCharacterHistorySnapshot(params.nextCharacter);
  const changes = diffCharacterHistorySnapshots(previousSnapshot, nextSnapshot);

  if (changes.length === 0) {
    return null;
  }

  const timestamp = params.timestamp ?? Date.now();
  const source = params.source;
  const fieldsChanged = changes.map((change) => change.field);
  const summary = buildHistorySummary(source, fieldsChanged);

  await runtime.createMemory(
    {
      entityId: runtime.agentId,
      roomId: params.roomId ?? runtime.agentId,
      content: {
        text: summary,
        source: "character_history",
      },
      metadata: {
        type: MemoryType.CUSTOM,
        service: "character_history",
        action:
          source === "restore" ? "character_restored" : "character_updated",
        timestamp,
        historySource: source,
        fieldsChanged,
        changes,
        before: previousSnapshot,
        after: nextSnapshot,
      },
    },
    CHARACTER_HISTORY_TABLE,
  );

  return {
    timestamp,
    source,
    summary,
    fieldsChanged,
    changes,
    before: previousSnapshot,
    after: nextSnapshot,
  };
}

export function parseCharacterHistoryEntry(
  memory: Memory,
): CharacterHistoryEntry | null {
  const metadata = isRecord(memory.metadata) ? memory.metadata : null;
  if (!metadata) {
    return null;
  }

  const action = metadata.action;
  if (action !== "character_updated" && action !== "character_restored") {
    return null;
  }

  const rawChanges = metadata.changes;
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    return null;
  }

  const changes: CharacterHistoryChange[] = [];
  for (const rawChange of rawChanges) {
    if (!isRecord(rawChange)) {
      return null;
    }
    const field = rawChange.field;
    if (
      typeof field !== "string" ||
      !CHARACTER_HISTORY_FIELDS.includes(field as CharacterHistoryField)
    ) {
      return null;
    }
    const before = Object.hasOwn(rawChange, "before")
      ? toCharacterHistoryValue(rawChange.before)
      : undefined;
    const after = Object.hasOwn(rawChange, "after")
      ? toCharacterHistoryValue(rawChange.after)
      : undefined;

    changes.push({
      field: field as CharacterHistoryField,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }

  const fieldsChanged = changes.map((change) => change.field);
  const timestamp =
    typeof metadata.timestamp === "number"
      ? metadata.timestamp
      : typeof memory.createdAt === "number"
        ? memory.createdAt
        : 0;

  return {
    id: typeof memory.id === "string" ? memory.id : undefined,
    timestamp,
    source: coerceHistorySource(metadata.historySource),
    summary:
      typeof memory.content.text === "string" && memory.content.text.trim()
        ? memory.content.text
        : buildHistorySummary(
            coerceHistorySource(metadata.historySource),
            fieldsChanged,
          ),
    fieldsChanged,
    changes,
    before: isRecord(metadata.before)
      ? (cloneJson(metadata.before) as CharacterHistorySnapshot)
      : {},
    after: isRecord(metadata.after)
      ? (cloneJson(metadata.after) as CharacterHistorySnapshot)
      : {},
  };
}

export async function listCharacterHistory(
  runtime: IAgentRuntime,
  limit = 20,
): Promise<CharacterHistoryEntry[]> {
  const safeLimit = Math.min(
    Math.max(Math.trunc(limit) || 20, 1),
    MAX_CHARACTER_HISTORY_LIMIT,
  );

  const memories = await runtime.getMemories({
    entityId: runtime.agentId,
    count: Math.max(safeLimit * 4, safeLimit),
    tableName: CHARACTER_HISTORY_TABLE,
  });

  return memories
    .map((memory) => parseCharacterHistoryEntry(memory))
    .filter((entry): entry is CharacterHistoryEntry => entry !== null)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, safeLimit);
}
