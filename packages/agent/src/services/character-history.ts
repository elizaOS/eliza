/**
 * Character-modification history. Builds normalized snapshots of a runtime
 * character, diffs consecutive snapshots field-by-field, and records each change
 * set as a CUSTOM memory in the `character_modifications` table (tagged manual /
 * agent / restore). Also parses those memory rows back into typed history
 * entries and lists them newest-first for the character-history surface.
 */
import {
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  type Memory,
  MemoryType,
} from "@elizaos/core";

export const CHARACTER_HISTORY_TABLE = "character_modifications";
export const MAX_CHARACTER_HISTORY_LIMIT = 100;
/**
 * Honest character snapshots are a handful of objects deep. Zod
 * `contentSchema.passthrough()` still admits extra keys that `JSON.parse`
 * already accepted, including a 20k-deep nest (~40 KiB) that then
 * RangeError'd `toCharacterHistoryValue` on origin develop.
 */
export const MAX_CHARACTER_HISTORY_WALK_DEPTH = 64;
export const MAX_CHARACTER_HISTORY_WALK_NODES = 100_000;
export const CHARACTER_HISTORY_UNBOUNDED = "CHARACTER_HISTORY_UNBOUNDED";

/** True when `error` is the typed unbounded-walk domain failure. */
export function isCharacterHistoryUnbounded(error: unknown): boolean {
  return isElizaError(error) && error.code === CHARACTER_HISTORY_UNBOUNDED;
}

/** Shared budget/cycle state for one bounded character walk. */
export type HistoryWalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

/**
 * The one domain failure this module raises. `ElizaError` carries the typed
 * `code`, the structured `context`, and the preserved `cause` chain the
 * fast-fail error policy requires of new/rewritten throw sites.
 */
function failHistoryUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError("Character history value exceeds the walk budget", {
    code: CHARACTER_HISTORY_UNBOUNDED,
    severity: "fatal",
    context,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function reserveHistoryVisits(ctx: HistoryWalkContext, count: number): void {
  if (count > MAX_CHARACTER_HISTORY_WALK_NODES - ctx.visits) {
    failHistoryUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_CHARACTER_HISTORY_WALK_NODES,
    });
  }
  ctx.visits += count;
}

function enterHistoryContainer(value: object, ctx: HistoryWalkContext): void {
  if (ctx.visiting.has(value)) {
    failHistoryUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
}

function inspectHistory<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
    failHistoryUnbounded({ inspection: operation }, cause);
  }
}

/** One enumerable own *data* property, captured by a single descriptor read. */
type HistoryDataEntry = { key: string; value: unknown };

/**
 * Capture every enumerable own string-keyed data property in ONE descriptor
 * read per key. Reading the descriptor twice (once to filter keys, once to take
 * the value) lets a Proxy drift between a benign descriptor and a different one,
 * so the walkers consume this stable snapshot and never re-reflect on the
 * source object.
 */
function ownEnumerableDataEntries(value: object): HistoryDataEntry[] {
  const entries: HistoryDataEntry[] = [];
  for (const key of inspectHistory("ownKeys", () => Reflect.ownKeys(value))) {
    if (typeof key !== "string") continue;
    const descriptor = inspectHistory("getOwnPropertyDescriptor", () =>
      Object.getOwnPropertyDescriptor(value, key),
    );
    if (!descriptor?.enumerable) continue;
    if (!("value" in descriptor)) {
      failHistoryUnbounded({ accessor: true, key });
    }
    entries.push({ key, value: descriptor.value });
  }
  return entries;
}

function sortHistoryEntriesByKey(
  entries: HistoryDataEntry[],
): HistoryDataEntry[] {
  return entries.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

function ownValueDescriptor(
  value: object,
  key: string,
): PropertyDescriptor | undefined {
  const descriptor = inspectHistory("getOwnPropertyDescriptor", () =>
    Object.getOwnPropertyDescriptor(value, key),
  );
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    failHistoryUnbounded({ accessor: true, key });
  }
  return descriptor;
}

/**
 * Descriptor-only single-property read. Returns `undefined` when the key is not
 * an own property and fails closed when it is an accessor, so callers can stage
 * submitted/live values without running getters or Proxy `get`/`has` traps.
 */
export function readOwnDataValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return ownValueDescriptor(value, key)?.value;
}

function isArrayValue(value: object): boolean {
  return inspectHistory("isArray", () => Array.isArray(value));
}

function createHistoryRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function ownArrayLength(value: object): number {
  const descriptor = ownValueDescriptor(value, "length");
  const length = descriptor?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_CHARACTER_HISTORY_WALK_NODES
  ) {
    failHistoryUnbounded({ arrayLength: length });
  }
  return length;
}

/**
 * Map an array's own numeric data properties, holes preserved.
 *
 * The whole *logical* length is reserved in the walk budget BEFORE the output
 * is sized and before any index descriptor is probed. Charging only for the
 * present elements let a graph of nested 100k-slot sparse arrays spend one
 * visit per container while performing millions of descriptor probes and
 * allocating millions of output slots.
 */
function mapOwnArrayData<T>(
  value: object,
  ctx: HistoryWalkContext,
  mapEntry: (entry: unknown) => T,
): T[] {
  const length = ownArrayLength(value);
  reserveHistoryVisits(ctx, length);
  const mapped: T[] = [];
  mapped.length = length;
  for (let index = 0; index < length; index += 1) {
    const descriptor = inspectHistory("getOwnPropertyDescriptor", () =>
      Object.getOwnPropertyDescriptor(value, String(index)),
    );
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      failHistoryUnbounded({ accessor: true, key: String(index) });
    }
    mapped[index] = mapEntry(descriptor.value);
  }
  return mapped;
}

export function createHistoryWalkContext(): HistoryWalkContext {
  return { visits: 0, visiting: new WeakSet<object>() };
}

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

export type CharacterHistoryValue =
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
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (cause) {
    // error-policy:J2 stringify/parse overflow or cycle is unbounded input.
    failHistoryUnbounded({ clone: true }, cause);
  }
}

function cloneIfDefined<T>(value: T): T {
  return value === undefined ? value : cloneJson(value);
}

/**
 * `reserved` is set by container walks that already charged this value's slot
 * to the budget (every array slot and every object entry is reserved up front),
 * so a node is never counted twice.
 */
function normalizeForCompare(
  value: unknown,
  depth = 0,
  ctx: HistoryWalkContext = createHistoryWalkContext(),
  reserved = false,
): unknown {
  if (depth > MAX_CHARACTER_HISTORY_WALK_DEPTH) {
    failHistoryUnbounded({
      depth,
      max: MAX_CHARACTER_HISTORY_WALK_DEPTH,
    });
  }
  if (!reserved) reserveHistoryVisits(ctx, 1);
  if (value === null || typeof value !== "object") {
    return value;
  }
  enterHistoryContainer(value, ctx);
  try {
    if (isArrayValue(value)) {
      return mapOwnArrayData(value, ctx, (entry) =>
        normalizeForCompare(entry, depth + 1, ctx, true),
      );
    }
    const entries = sortHistoryEntriesByKey(ownEnumerableDataEntries(value));
    reserveHistoryVisits(ctx, entries.length);
    const normalized = createHistoryRecord<unknown>();
    for (const entry of entries) {
      normalized[entry.key] = normalizeForCompare(
        entry.value,
        depth + 1,
        ctx,
        true,
      );
    }
    return normalized;
  } finally {
    ctx.visiting.delete(value);
  }
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
  depth = 0,
  ctx: HistoryWalkContext = createHistoryWalkContext(),
  reserved = false,
): CharacterHistoryValue | undefined {
  if (depth > MAX_CHARACTER_HISTORY_WALK_DEPTH) {
    failHistoryUnbounded({
      depth,
      max: MAX_CHARACTER_HISTORY_WALK_DEPTH,
    });
  }
  if (!reserved) reserveHistoryVisits(ctx, 1);
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
  if (typeof value !== "object") {
    return undefined;
  }
  enterHistoryContainer(value, ctx);
  try {
    if (isArrayValue(value)) {
      return mapOwnArrayData(
        value,
        ctx,
        (entry) => toCharacterHistoryValue(entry, depth + 1, ctx, true) ?? null,
      ) as CharacterHistoryValue[];
    }
    const entries = ownEnumerableDataEntries(value);
    reserveHistoryVisits(ctx, entries.length);
    const normalized = createHistoryRecord<CharacterHistoryValue | undefined>();
    for (const entry of entries) {
      const normalizedEntry = toCharacterHistoryValue(
        entry.value,
        depth + 1,
        ctx,
        true,
      );
      if (normalizedEntry !== undefined) {
        normalized[entry.key] = normalizedEntry;
      }
    }
    return normalized;
  } finally {
    ctx.visiting.delete(value);
  }
}

/** Descriptor-only, budget-charged array field read. */
function snapshotArrayField(
  value: unknown,
  ctx: HistoryWalkContext,
): CharacterHistoryValue[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!isArrayValue(value)) return undefined;
  const walked = toCharacterHistoryValue(value, 0, ctx);
  return Array.isArray(walked) ? walked : undefined;
}

const CHARACTER_STYLE_KEYS = ["all", "chat", "post"] as const;

/**
 * Build the bounded snapshot of a character.
 *
 * Every field is read through own *data* descriptors and walked with a single
 * shared budget, so this is the one trusted, descriptor-only projection of a
 * live or submitted character: no accessor, no Proxy `get`/`has` trap, and no
 * unwrapped `Array.isArray` runs on caller-supplied values, and one hostile
 * field cannot spend an independent walk budget.
 */
/**
 * Bounded, descriptor-only projection of ONE caller-supplied value into inert
 * plain data (arrays keep holes, objects become null-prototype records).
 *
 * This is the value authority for staging a `PUT /api/character` field: unlike
 * {@link buildCharacterHistorySnapshot} it preserves *presence*, so a
 * schema-valid empty clear (`""`, `{}`, `[]`) survives staging instead of being
 * normalized away by the history-display rules. Shares `ctx`, so every staged
 * field is charged to one aggregate walk budget.
 */
export function toBoundedCharacterValue(
  value: unknown,
  ctx: HistoryWalkContext,
): CharacterHistoryValue | undefined {
  return toCharacterHistoryValue(value, 0, ctx);
}

export function buildCharacterHistorySnapshot(
  character: RuntimeCharacterLike,
  ctx: HistoryWalkContext = createHistoryWalkContext(),
): CharacterHistorySnapshot {
  const snapshot: CharacterHistorySnapshot = {};
  if (character === null || typeof character !== "object") return snapshot;
  reserveHistoryVisits(ctx, 1);

  const name = readOwnDataValue(character, "name");
  if (typeof name === "string" && name.trim()) {
    snapshot.name = name.trim();
  }
  const username = readOwnDataValue(character, "username");
  if (typeof username === "string" && username.trim()) {
    snapshot.username = username.trim();
  }
  const bio = readOwnDataValue(character, "bio");
  const bioArray = snapshotArrayField(bio, ctx);
  if (bioArray) {
    snapshot.bio = bioArray as string[];
  } else if (typeof bio === "string" && bio.trim()) {
    snapshot.bio = [bio];
  }
  const system = readOwnDataValue(character, "system");
  if (typeof system === "string") {
    snapshot.system = system;
  }
  const adjectives = snapshotArrayField(
    readOwnDataValue(character, "adjectives"),
    ctx,
  );
  if (adjectives) snapshot.adjectives = adjectives as string[];
  const topics = snapshotArrayField(readOwnDataValue(character, "topics"), ctx);
  if (topics) snapshot.topics = topics as string[];

  const styleValue = readOwnDataValue(character, "style");
  if (styleValue !== null && typeof styleValue === "object") {
    const walkedStyle = toCharacterHistoryValue(styleValue, 0, ctx);
    if (walkedStyle !== null && typeof walkedStyle === "object") {
      const style: NonNullable<CharacterHistorySnapshot["style"]> = {};
      for (const key of CHARACTER_STYLE_KEYS) {
        const entry = Object.hasOwn(walkedStyle, key)
          ? (walkedStyle as Record<string, CharacterHistoryValue>)[key]
          : undefined;
        if (Array.isArray(entry)) style[key] = entry as string[];
      }
      if (Object.keys(style).length > 0) {
        snapshot.style = style;
      }
    }
  }

  const messageExamples = snapshotArrayField(
    readOwnDataValue(character, "messageExamples"),
    ctx,
  );
  if (messageExamples) snapshot.messageExamples = messageExamples;

  const postExamples = snapshotArrayField(
    readOwnDataValue(character, "postExamples"),
    ctx,
  );
  if (postExamples) snapshot.postExamples = postExamples as string[];

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

function cloneSnapshotOrNull(
  value: Record<string, unknown>,
): CharacterHistorySnapshot | null {
  try {
    return cloneJson(value) as CharacterHistorySnapshot;
  } catch (error) {
    // error-policy:J3 omit a poisoned stored row instead of fabricating a snapshot.
    if (isCharacterHistoryUnbounded(error)) {
      return null;
    }
    throw error;
  }
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
    let before: CharacterHistoryValue | undefined;
    let after: CharacterHistoryValue | undefined;
    try {
      before = Object.hasOwn(rawChange, "before")
        ? toCharacterHistoryValue(rawChange.before)
        : undefined;
      after = Object.hasOwn(rawChange, "after")
        ? toCharacterHistoryValue(rawChange.after)
        : undefined;
    } catch (error) {
      // error-policy:J3 a poisoned stored change is not a live input 500.
      if (isCharacterHistoryUnbounded(error)) {
        return null;
      }
      throw error;
    }

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

  const before = isRecord(metadata.before)
    ? cloneSnapshotOrNull(metadata.before)
    : {};
  if (before === null) {
    return null;
  }
  const after = isRecord(metadata.after)
    ? cloneSnapshotOrNull(metadata.after)
    : {};
  if (after === null) {
    return null;
  }

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
    before,
    after,
  };
}

export async function listCharacterHistory(
  runtime: IAgentRuntime,
  limit = 20,
): Promise<CharacterHistoryEntry[]> {
  const safeLimit = Math.min(
    Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20),
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
