/**
 * Canonical wire contract for moving one personal Shared Todo snapshot into a
 * Dedicated agent. Both the Cloudflare cutover coordinator and the container
 * import boundary use this module so validation, bounds, ordering, and digest
 * verification cannot drift between the two runtimes.
 */

import { validateUuid } from "@elizaos/core/edge";

export const SHARED_TODO_CUTOVER_VERSION = 2 as const;
export const SHARED_TODO_MUTATION_WIRE_VERSION = 1 as const;
export const MAX_SHARED_TODO_CUTOVER_COUNT = 1_000;
export const MAX_SHARED_TODO_CUTOVER_MUTATION_COUNT = 4_096;
export const MAX_SHARED_TODO_CUTOVER_BYTES = 4 * 1024 * 1024;
export const TODO_CUTOVER_PROVENANCE_KEY = "__elizaSharedTodoImport";

const MAX_ID_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 1_024;
const MAX_CONTENT_LENGTH = 16_384;
const MAX_ACTIVE_FORM_LENGTH = 4_096;
const MAX_METADATA_DEPTH = 32;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const SHARED_TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type SharedTodoStatus = (typeof SHARED_TODO_STATUSES)[number];
export const SHARED_TODO_MUTATION_OPERATIONS = [
  "create",
  "update",
  "complete",
  "cancel",
  "delete",
  "write",
  "clear",
] as const;
export type SharedTodoMutationOperation =
  (typeof SHARED_TODO_MUTATION_OPERATIONS)[number];
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

export interface SharedTodoMutationCutoverRecord {
  version: typeof SHARED_TODO_MUTATION_WIRE_VERSION;
  mutationId: string;
  idempotencyKey: string;
  requestDigest: string;
  operation: SharedTodoMutationOperation;
  applied: boolean;
  resultJson: unknown;
  committedAt: string;
}

export interface SharedTodoCutoverSnapshot {
  version: typeof SHARED_TODO_CUTOVER_VERSION;
  sourceAgentId: string;
  todos: SharedTodoCutoverRecord[];
  mutations: SharedTodoMutationCutoverRecord[];
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

function requiredUuid(value: unknown, field: string): string {
  const raw = requiredString(value, field, MAX_ID_LENGTH);
  if (!validateUuid(raw)) {
    return invalid("TODO_CUTOVER_INVALID_UUID", `${field} must be a UUID`);
  }
  return raw.toLowerCase();
}

function nullableUuid(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredUuid(value, field);
}

function hasValidIsoCalendarFields(raw: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(raw);
  if (!match) return false;

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second
  );
}

function canonicalTimestamp(value: unknown, field: string): string {
  const raw = requiredString(value, field, 64);
  const timestamp = new Date(raw);
  if (
    !hasValidIsoCalendarFields(raw) ||
    !Number.isFinite(timestamp.getTime())
  ) {
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
    sourceId: requiredUuid(value.sourceId, `todos[${index}].sourceId`),
    roomId: nullableUuid(value.roomId, `todos[${index}].roomId`),
    worldId: nullableUuid(value.worldId, `todos[${index}].worldId`),
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
    parentSourceId: nullableUuid(
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

function normalizeMutation(
  value: unknown,
  index: number,
): SharedTodoMutationCutoverRecord {
  if (!isRecord(value)) {
    return invalid(
      "TODO_CUTOVER_INVALID_MUTATION_RECORD",
      `mutations[${index}] must be an object`,
    );
  }
  if (value.version !== SHARED_TODO_MUTATION_WIRE_VERSION) {
    return invalid(
      "TODO_CUTOVER_INVALID_MUTATION_VERSION",
      `mutations[${index}].version is invalid`,
    );
  }
  const idempotencyKey = requiredString(
    value.idempotencyKey,
    `mutations[${index}].idempotencyKey`,
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  if (idempotencyKey.trim().length === 0) {
    return invalid(
      "TODO_CUTOVER_INVALID_FIELD",
      `mutations[${index}].idempotencyKey must not be blank`,
    );
  }
  const requestDigest = requiredString(
    value.requestDigest,
    `mutations[${index}].requestDigest`,
    64,
  );
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    return invalid(
      "TODO_CUTOVER_INVALID_REQUEST_DIGEST",
      `mutations[${index}].requestDigest must be a lowercase SHA-256 digest`,
    );
  }
  if (
    !SHARED_TODO_MUTATION_OPERATIONS.includes(
      value.operation as SharedTodoMutationOperation,
    )
  ) {
    return invalid(
      "TODO_CUTOVER_INVALID_MUTATION_OPERATION",
      `mutations[${index}].operation is invalid`,
    );
  }
  if (typeof value.applied !== "boolean") {
    return invalid(
      "TODO_CUTOVER_INVALID_FIELD",
      `mutations[${index}].applied must be a boolean`,
    );
  }
  return {
    version: SHARED_TODO_MUTATION_WIRE_VERSION,
    mutationId: requiredUuid(
      value.mutationId,
      `mutations[${index}].mutationId`,
    ),
    idempotencyKey,
    requestDigest,
    operation: value.operation as SharedTodoMutationOperation,
    applied: value.applied,
    resultJson: canonicalJsonValue(
      value.resultJson,
      `mutations[${index}].resultJson`,
    ),
    committedAt: canonicalTimestamp(
      value.committedAt,
      `mutations[${index}].committedAt`,
    ),
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

function assertUniqueMutations(
  mutations: readonly SharedTodoMutationCutoverRecord[],
): void {
  const mutationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const mutation of mutations) {
    if (mutationIds.has(mutation.mutationId)) {
      invalid(
        "TODO_CUTOVER_DUPLICATE_MUTATION_ID",
        "Todo mutation ids must be unique",
      );
    }
    mutationIds.add(mutation.mutationId);
    if (idempotencyKeys.has(mutation.idempotencyKey)) {
      invalid(
        "TODO_CUTOVER_DUPLICATE_IDEMPOTENCY_KEY",
        "Todo mutation idempotency keys must be unique",
      );
    }
    idempotencyKeys.add(mutation.idempotencyKey);
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
  mutations: readonly SharedTodoMutationCutoverRecord[],
): string {
  return JSON.stringify({
    version: SHARED_TODO_CUTOVER_VERSION,
    sourceAgentId,
    todos,
    mutations,
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
  mutations: readonly unknown[];
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
  if (input.mutations.length > MAX_SHARED_TODO_CUTOVER_MUTATION_COUNT) {
    invalid(
      "TODO_CUTOVER_TOO_MANY_MUTATIONS",
      `Todo snapshot exceeds ${MAX_SHARED_TODO_CUTOVER_MUTATION_COUNT} mutations`,
    );
  }
  const todos = input.todos
    .map((todo, index) => normalizeRecord(todo, index))
    .sort((left, right) =>
      compareCanonicalStrings(left.sourceId, right.sourceId),
    );
  assertHierarchy(todos);
  const mutations = input.mutations
    .map((mutation, index) => normalizeMutation(mutation, index))
    .sort(
      (left, right) =>
        compareCanonicalStrings(left.committedAt, right.committedAt) ||
        compareCanonicalStrings(left.mutationId, right.mutationId),
    );
  assertUniqueMutations(mutations);
  const payload = canonicalPayload(sourceAgentId, todos, mutations);
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
    mutations,
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
  if (!Array.isArray(value.mutations)) {
    return invalid(
      "TODO_CUTOVER_INVALID_MUTATIONS",
      "Todo snapshot must include a mutations array",
    );
  }
  const normalized = await createSharedTodoCutoverSnapshot({
    sourceAgentId: value.sourceAgentId as string,
    todos: value.todos,
    mutations: value.mutations,
  });
  if (typeof value.digest !== "string" || value.digest !== normalized.digest) {
    return invalid(
      "TODO_CUTOVER_DIGEST_MISMATCH",
      "Todo snapshot digest does not match its records",
    );
  }
  return normalized;
}
