/**
 * Canonical wire contract for moving one personal Shared Todo snapshot into a
 * Dedicated agent. Both the Cloudflare cutover coordinator and the container
 * import boundary use this module so validation, bounds, ordering, and digest
 * verification cannot drift between the two runtimes.
 */

export const SHARED_TODO_CUTOVER_VERSION = 1 as const;
export const MAX_SHARED_TODO_CUTOVER_COUNT = 1_000;
export const MAX_SHARED_TODO_CUTOVER_BYTES = 1_000_000;
export const TODO_CUTOVER_PROVENANCE_KEY = "__elizaSharedTodoImport";

const MAX_ID_LENGTH = 256;
const MAX_CONTENT_LENGTH = 16_384;
const MAX_ACTIVE_FORM_LENGTH = 4_096;
const MAX_METADATA_DEPTH = 32;

export const SHARED_TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type SharedTodoStatus = (typeof SHARED_TODO_STATUSES)[number];
export type TodoCutoverJsonValue =
  | null
  | boolean
  | number
  | string
  | TodoCutoverJsonValue[]
  | { [key: string]: TodoCutoverJsonValue };

export interface SharedTodoCutoverRecord {
  sourceId: string;
  roomId: string | null;
  worldId: string | null;
  content: string;
  activeForm: string;
  status: SharedTodoStatus;
  parentSourceId: string | null;
  parentTrajectoryStepId: string | null;
  metadata: Record<string, TodoCutoverJsonValue>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SharedTodoCutoverSnapshot {
  version: typeof SHARED_TODO_CUTOVER_VERSION;
  sourceAgentId: string;
  todos: SharedTodoCutoverRecord[];
  digest: string;
}

export class TodoCutoverContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TodoCutoverContractError";
  }
}

function invalid(code: string, message: string): never {
  throw new TodoCutoverContractError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(
      "TODO_CUTOVER_INVALID_FIELD",
      `${field} must be a non-empty string`,
    );
  }
  if (value.length > maxLength) {
    return invalid(
      "TODO_CUTOVER_FIELD_TOO_LARGE",
      `${field} exceeds ${maxLength} characters`,
    );
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field, MAX_ID_LENGTH);
}

function canonicalTimestamp(value: unknown, field: string): string {
  const raw = requiredString(value, field, 64);
  const timestamp = new Date(raw);
  if (!Number.isFinite(timestamp.getTime())) {
    return invalid(
      "TODO_CUTOVER_INVALID_TIMESTAMP",
      `${field} must be an ISO timestamp`,
    );
  }
  return timestamp.toISOString();
}

function canonicalJsonValue(
  value: unknown,
  path: string,
  depth = 0,
): TodoCutoverJsonValue {
  if (depth > MAX_METADATA_DEPTH) {
    return invalid(
      "TODO_CUTOVER_METADATA_TOO_DEEP",
      `${path} exceeds ${MAX_METADATA_DEPTH} nested levels`,
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalid(
        "TODO_CUTOVER_INVALID_METADATA",
        `${path} contains a non-finite number`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalJsonValue(entry, `${path}[${index}]`, depth + 1),
    );
  }
  if (!isRecord(value)) {
    return invalid(
      "TODO_CUTOVER_INVALID_METADATA",
      `${path} must contain JSON values only`,
    );
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalJsonValue(value[key], `${path}.${key}`, depth + 1),
      ]),
  );
}

function normalizeRecord(
  value: unknown,
  index: number,
): SharedTodoCutoverRecord {
  if (!isRecord(value)) {
    return invalid(
      "TODO_CUTOVER_INVALID_RECORD",
      `todos[${index}] must be an object`,
    );
  }
  if (!SHARED_TODO_STATUSES.includes(value.status as SharedTodoStatus)) {
    return invalid(
      "TODO_CUTOVER_INVALID_STATUS",
      `todos[${index}].status is invalid`,
    );
  }
  if (!isRecord(value.metadata)) {
    return invalid(
      "TODO_CUTOVER_INVALID_METADATA",
      `todos[${index}].metadata must be an object`,
    );
  }
  if (Object.hasOwn(value.metadata, TODO_CUTOVER_PROVENANCE_KEY)) {
    return invalid(
      "TODO_CUTOVER_RESERVED_METADATA",
      `todos[${index}].metadata uses a reserved cutover key`,
    );
  }
  const completedAt =
    value.completedAt === null
      ? null
      : canonicalTimestamp(value.completedAt, `todos[${index}].completedAt`);
  return {
    sourceId: requiredString(
      value.sourceId,
      `todos[${index}].sourceId`,
      MAX_ID_LENGTH,
    ),
    roomId: nullableString(value.roomId, `todos[${index}].roomId`),
    worldId: nullableString(value.worldId, `todos[${index}].worldId`),
    content: requiredString(
      value.content,
      `todos[${index}].content`,
      MAX_CONTENT_LENGTH,
    ),
    activeForm: requiredString(
      value.activeForm,
      `todos[${index}].activeForm`,
      MAX_ACTIVE_FORM_LENGTH,
    ),
    status: value.status as SharedTodoStatus,
    parentSourceId: nullableString(
      value.parentSourceId,
      `todos[${index}].parentSourceId`,
    ),
    parentTrajectoryStepId: nullableString(
      value.parentTrajectoryStepId,
      `todos[${index}].parentTrajectoryStepId`,
    ),
    metadata: canonicalJsonValue(
      value.metadata,
      `todos[${index}].metadata`,
    ) as Record<string, TodoCutoverJsonValue>,
    createdAt: canonicalTimestamp(value.createdAt, `todos[${index}].createdAt`),
    updatedAt: canonicalTimestamp(value.updatedAt, `todos[${index}].updatedAt`),
    completedAt,
  };
}

function assertHierarchy(todos: readonly SharedTodoCutoverRecord[]): void {
  const byId = new Map(todos.map((todo) => [todo.sourceId, todo]));
  if (byId.size !== todos.length) {
    invalid("TODO_CUTOVER_DUPLICATE_ID", "Todo source ids must be unique");
  }
  for (const todo of todos) {
    if (!todo.parentSourceId) continue;
    if (!byId.has(todo.parentSourceId)) {
      invalid(
        "TODO_CUTOVER_INVALID_PARENT",
        `Todo ${todo.sourceId} references a parent outside the snapshot`,
      );
    }
    const visited = new Set([todo.sourceId]);
    let cursor: SharedTodoCutoverRecord | undefined = todo;
    while (cursor?.parentSourceId) {
      if (visited.has(cursor.parentSourceId)) {
        invalid(
          "TODO_CUTOVER_PARENT_CYCLE",
          "Todo snapshot contains a parent cycle",
        );
      }
      visited.add(cursor.parentSourceId);
      cursor = byId.get(cursor.parentSourceId);
    }
  }
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalPayload(
  sourceAgentId: string,
  todos: readonly SharedTodoCutoverRecord[],
): string {
  return JSON.stringify({
    version: SHARED_TODO_CUTOVER_VERSION,
    sourceAgentId,
    todos,
  });
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Builds the exact bounded snapshot sent from Shared to Dedicated. */
export async function createSharedTodoCutoverSnapshot(input: {
  sourceAgentId: string;
  todos: readonly unknown[];
}): Promise<SharedTodoCutoverSnapshot> {
  const sourceAgentId = requiredString(
    input.sourceAgentId,
    "sourceAgentId",
    MAX_ID_LENGTH,
  );
  if (input.todos.length > MAX_SHARED_TODO_CUTOVER_COUNT) {
    invalid(
      "TODO_CUTOVER_TOO_MANY_RECORDS",
      `Todo snapshot exceeds ${MAX_SHARED_TODO_CUTOVER_COUNT} records`,
    );
  }
  const todos = input.todos
    .map((todo, index) => normalizeRecord(todo, index))
    .sort((left, right) =>
      compareCanonicalStrings(left.sourceId, right.sourceId),
    );
  assertHierarchy(todos);
  const payload = canonicalPayload(sourceAgentId, todos);
  if (encodedBytes(payload) > MAX_SHARED_TODO_CUTOVER_BYTES) {
    invalid(
      "TODO_CUTOVER_PAYLOAD_TOO_LARGE",
      `Todo snapshot exceeds ${MAX_SHARED_TODO_CUTOVER_BYTES} bytes`,
    );
  }
  return {
    version: SHARED_TODO_CUTOVER_VERSION,
    sourceAgentId,
    todos,
    digest: await sha256Hex(payload),
  };
}

/** Parses and verifies an untrusted snapshot at the Dedicated HTTP boundary. */
export async function parseSharedTodoCutoverSnapshot(
  value: unknown,
): Promise<SharedTodoCutoverSnapshot> {
  if (!isRecord(value) || value.version !== SHARED_TODO_CUTOVER_VERSION) {
    return invalid(
      "TODO_CUTOVER_INVALID_VERSION",
      "Todo snapshot version is invalid",
    );
  }
  if (!Array.isArray(value.todos)) {
    return invalid(
      "TODO_CUTOVER_INVALID_RECORDS",
      "Todo snapshot must include a todos array",
    );
  }
  const normalized = await createSharedTodoCutoverSnapshot({
    sourceAgentId: value.sourceAgentId as string,
    todos: value.todos,
  });
  if (typeof value.digest !== "string" || value.digest !== normalized.digest) {
    return invalid(
      "TODO_CUTOVER_DIGEST_MISMATCH",
      "Todo snapshot digest does not match its records",
    );
  }
  return normalized;
}
