/**
 * @module storage
 * @description Component-based persistence for form data
 *
 * ## Design Rationale
 *
 * Form data is stored using elizaOS's Component system because:
 *
 * 1. **Entity-Scoped**: Components belong to entities (users).
 *    This naturally scopes form data per-user.
 *
 * 2. **Typed Storage**: Component type field allows different kinds
 *    of form data (sessions, submissions, autofill).
 *
 * 3. **No Custom Schema**: Uses existing elizaOS infrastructure,
 *    no need to create database tables.
 *
 * 4. **Room Scoping**: Component type includes roomId for session
 *    isolation across rooms.
 *
 * ## Storage Strategy
 *
 * ### Sessions
 * - Stored as components with type: `form_session:{roomId}:{sessionId}`
 * - One active/ready session per user per room, but multiple stashed
 *   sessions (and a stashed session alongside a new active one) can coexist
 * - The session id is part of the component type so distinct sessions in the
 *   same room map to distinct natural keys and never overwrite each other
 * - Room scoping ensures different rooms have different contexts
 * - Deployments upgrading from the pre-session-id `form_session:{roomId}` key
 *   have their in-flight session's legacy component retired on the next
 *   saveSession/deleteSession so the stale row cannot shadow the new key
 *
 * ### Submissions
 * - Stored as components with type: `form_submission:{formId}:{submissionId}`
 * - Immutable records of completed forms
 * - Multiple submissions per user (if form allows)
 *
 * ### Autofill
 * - Stored as components with type: `form_autofill:{formId}`
 * - One autofill record per user per form
 * - Updated on each submission
 *
 * ## Component-store tradeoffs
 *
 * The component-backed implementation has two important scaling properties:
 *
 * 1. **No Cross-Entity Queries**: Can't efficiently find all stale
 *    sessions across all users. This affects nudge system.
 *
 * 2. **No Indexes**: Component queries are sequential scans.
 *    High-volume deployments should add database-level optimizations.
 *
 * These tradeoffs keep the plugin self-contained on the elizaOS component
 * store while preserving a clear path for deployments that need indexed
 * operational queries.
 */

import {
  type Component,
  ElizaError,
  type IAgentRuntime,
  type JsonValue,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { isExpired, isExpiringSoon } from "./ttl";
import type { FormAutofillData, FormSession, FormSubmission } from "./types";
import {
  FORM_AUTOFILL_COMPONENT,
  FORM_SESSION_COMPONENT,
  FORM_SUBMISSION_COMPONENT,
} from "./types";

const isRecord = (
  value: JsonValue | object,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveComponentContext = async (
  runtime: IAgentRuntime,
  roomId?: UUID,
): Promise<{ roomId: UUID; worldId: UUID }> => {
  if (roomId) {
    const room = await runtime.getRoom(roomId);
    return { roomId, worldId: room?.worldId ?? runtime.agentId };
  }
  return { roomId: runtime.agentId, worldId: runtime.agentId };
};

const isFormSessionIdentity = (
  data: JsonValue | object,
): data is FormSession => {
  if (!isRecord(data)) return false;
  return (
    typeof data.id === "string" &&
    typeof data.formId === "string" &&
    typeof data.entityId === "string" &&
    typeof data.roomId === "string"
  );
};

const isFormSession = (data: JsonValue | object): data is FormSession =>
  isFormSessionIdentity(data) &&
  typeof data.updatedAt === "number" &&
  Number.isFinite(data.updatedAt);

const isLiveSession = (session: FormSession): boolean => !isExpired(session);

export const MAX_FORM_COMPONENT_DATA_DEPTH = 64;
export const MAX_FORM_COMPONENT_DATA_NODES = 100_000;
export const MAX_FORM_COMPONENT_DATA_BYTES = 1024 * 1024;
export const FORM_COMPONENT_DATA_UNBOUNDED = "FORM_COMPONENT_DATA_UNBOUNDED";

const OMIT_COMPONENT_VALUE = Symbol("omit-component-value");
type ComponentValue = JsonValue | typeof OMIT_COMPONENT_VALUE;
type ComponentWalk = {
  bytes: number;
  nodes: number;
  visiting: WeakSet<object>;
};

function failComponentData(
  reason: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): never {
  throw new ElizaError("Form component data is not bounded JSON", {
    code: FORM_COMPONENT_DATA_UNBOUNDED,
    context: { reason, ...context },
    cause,
  });
}

function inspectComponentData<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J2 Preserve hostile reflection failures at the persistence boundary.
    failComponentData("reflection", { operation }, cause);
  }
}

function reserveNodes(walk: ComponentWalk, count = 1): void {
  if (count > MAX_FORM_COMPONENT_DATA_NODES - walk.nodes) {
    failComponentData("nodes", {
      maxNodes: MAX_FORM_COMPONENT_DATA_NODES,
      nodes: walk.nodes + count,
    });
  }
  walk.nodes += count;
}

function reserveBytes(walk: ComponentWalk, count: number): void {
  if (count > MAX_FORM_COMPONENT_DATA_BYTES - walk.bytes) {
    failComponentData("bytes", {
      maxBytes: MAX_FORM_COMPONENT_DATA_BYTES,
      bytes: walk.bytes + count,
    });
  }
  walk.bytes += count;
}

function jsonStringBytes(value: string): number {
  if (value.length > MAX_FORM_COMPONENT_DATA_BYTES) {
    failComponentData("bytes", {
      maxBytes: MAX_FORM_COMPONENT_DATA_BYTES,
      minimumBytes: value.length,
    });
  }
  const encoded = JSON.stringify(value);
  return new TextEncoder().encode(encoded).byteLength;
}

function defineComponentProperty(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function toComponentValue(
  value: unknown,
  walk: ComponentWalk,
  depth: number,
  arrayElement = false,
): ComponentValue {
  if (depth > MAX_FORM_COMPONENT_DATA_DEPTH) {
    failComponentData("depth", {
      depth,
      maxDepth: MAX_FORM_COMPONENT_DATA_DEPTH,
    });
  }
  reserveNodes(walk);

  if (value === null) {
    reserveBytes(walk, 4);
    return null;
  }
  switch (typeof value) {
    case "string":
      reserveBytes(walk, jsonStringBytes(value));
      return value;
    case "boolean":
      reserveBytes(walk, value ? 4 : 5);
      return value;
    case "number": {
      if (!Number.isFinite(value)) {
        reserveBytes(walk, 4);
        return null;
      }
      reserveBytes(walk, String(value).length);
      return value;
    }
    case "undefined":
    case "function":
    case "symbol":
      if (arrayElement) {
        reserveBytes(walk, 4);
        return null;
      }
      return OMIT_COMPONENT_VALUE;
    case "bigint":
      failComponentData("unsupported", { type: "bigint" });
  }

  if (walk.visiting.has(value)) {
    failComponentData("cycle");
  }
  walk.visiting.add(value);
  try {
    const isArray = inspectComponentData("Array.isArray", () =>
      Array.isArray(value),
    );
    if (isArray) {
      const lengthDescriptor = inspectComponentData("array.length", () =>
        Object.getOwnPropertyDescriptor(value, "length"),
      );
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        failComponentData("array-length");
      }
      if (length > MAX_FORM_COMPONENT_DATA_NODES - walk.nodes) {
        failComponentData("nodes", {
          maxNodes: MAX_FORM_COMPONENT_DATA_NODES,
          nodes: walk.nodes + length,
        });
      }
      const result: JsonValue[] = new Array(length);
      reserveBytes(walk, 2 + Math.max(0, length - 1));
      for (let index = 0; index < length; index += 1) {
        const descriptor = inspectComponentData(`array[${index}]`, () =>
          Object.getOwnPropertyDescriptor(value, String(index)),
        );
        if (!descriptor) {
          reserveNodes(walk);
          reserveBytes(walk, 4);
          result[index] = null;
          continue;
        }
        if (!("value" in descriptor)) {
          failComponentData("accessor", { key: String(index) });
        }
        const item = toComponentValue(descriptor.value, walk, depth + 1, true);
        result[index] = item === OMIT_COMPONENT_VALUE ? null : item;
      }
      return result;
    }

    const prototype = inspectComponentData("Object.getPrototypeOf", () =>
      Object.getPrototypeOf(value),
    );
    if (prototype !== null && prototype !== Object.prototype) {
      failComponentData("unsupported", { type: "non-plain-object" });
    }
    const keys = inspectComponentData("Reflect.ownKeys", () =>
      Reflect.ownKeys(value),
    );
    if (keys.length > MAX_FORM_COMPONENT_DATA_NODES - walk.nodes) {
      failComponentData("nodes", {
        maxNodes: MAX_FORM_COMPONENT_DATA_NODES,
        nodes: walk.nodes + keys.length,
      });
    }
    const result: Record<string, JsonValue> = Object.create(null);
    reserveBytes(walk, 2);
    let properties = 0;
    for (const key of keys) {
      if (typeof key !== "string") {
        reserveNodes(walk);
        continue;
      }
      const descriptor = inspectComponentData(`object.${key}`, () =>
        Object.getOwnPropertyDescriptor(value, key),
      );
      if (!descriptor?.enumerable) {
        reserveNodes(walk);
        continue;
      }
      if (!("value" in descriptor)) {
        failComponentData("accessor", { key });
      }
      const child = toComponentValue(descriptor.value, walk, depth + 1);
      if (child === OMIT_COMPONENT_VALUE) continue;
      reserveBytes(walk, jsonStringBytes(key) + 1 + (properties > 0 ? 1 : 0));
      defineComponentProperty(result, key, child);
      properties += 1;
    }
    return result;
  } finally {
    walk.visiting.delete(value);
  }
}

/**
 * Safely serialize data into plain JSON component data, guarding against
 * circular structures and non-serializable objects.
 */
export function toComponentData<T extends object>(
  value: T,
): Record<string, JsonValue> {
  const walk: ComponentWalk = {
    bytes: 0,
    nodes: 0,
    visiting: new WeakSet(),
  };
  const data = toComponentValue(value, walk, 0);
  if (data === OMIT_COMPONENT_VALUE || Array.isArray(data) || !isRecord(data)) {
    failComponentData("root");
  }
  return data;
}

/**
 * Build the component type (natural key suffix) for a session.
 *
 * WHY the session id is included:
 * - The runtime stores/looks up components by the natural key (entityId, type).
 * - Keying only by room (`form_session:{roomId}`) let a single (entity, room)
 *   hold just one session component, so stashing a session and then starting a
 *   new one in the same room silently overwrote and destroyed the stash.
 * - Including the session id gives every session its own natural key, so a
 *   stashed session survives new activity in the same room.
 */
const sessionComponentType = (roomId: UUID, sessionId: string): string =>
  `${FORM_SESSION_COMPONENT}:${roomId}:${sessionId}`;

/**
 * Build the pre-upgrade component type that keyed a session by room only.
 *
 * WHY this still matters:
 * - Deployments that ran the old code persisted in-flight sessions under
 *   `form_session:{roomId}` (one row per room, no session id).
 * - After upgrading, saveSession/deleteSession write the new session-id key,
 *   which is a different natural key, so getComponent misses the legacy row.
 * - Left untouched, that stale `active` row keeps satisfying getActiveSession
 *   and blocks startSession. retireLegacySessionComponent removes it once the
 *   owning session has been re-persisted (or deleted) under the new key.
 */
const legacySessionComponentType = (roomId: UUID): string =>
  `${FORM_SESSION_COMPONENT}:${roomId}`;

/**
 * Delete the pre-upgrade room-only component for a session, if present.
 *
 * Only removes the legacy row when it actually holds this session's data, so a
 * room-only row belonging to a different session id is never touched.
 */
const retireLegacySessionComponent = async (
  runtime: IAgentRuntime,
  session: FormSession,
): Promise<void> => {
  const legacy = await runtime.getComponent(
    session.entityId,
    legacySessionComponentType(session.roomId),
  );
  if (
    legacy?.data &&
    isFormSession(legacy.data) &&
    legacy.data.id === session.id
  ) {
    await runtime.deleteComponent(legacy.id);
  }
};

const RESTORABLE_SESSION_STATUSES: FormSession["status"][] = [
  "active",
  "ready",
  "stashed",
];
const RESTORABLE_SESSION_SCAN_LIMIT = 100;

const isFormSubmission = (data: JsonValue | object): data is FormSubmission => {
  if (!isRecord(data)) return false;
  return (
    typeof data.id === "string" &&
    typeof data.formId === "string" &&
    typeof data.sessionId === "string" &&
    typeof data.entityId === "string"
  );
};

const isFormAutofillData = (
  data: JsonValue | object,
): data is FormAutofillData => {
  if (!isRecord(data)) return false;
  return (
    typeof data.formId === "string" &&
    typeof data.updatedAt === "number" &&
    typeof data.values === "object"
  );
};

const getRestorableSessions = async (
  runtime: IAgentRuntime,
): Promise<FormSession[]> => {
  const sessionsById = new Map<string, FormSession>();
  let offset = 0;

  while (true) {
    const entities = await runtime.queryEntities({
      agentId: runtime.agentId,
      includeAllComponents: true,
      limit: RESTORABLE_SESSION_SCAN_LIMIT,
      offset,
    });

    for (const entity of entities) {
      for (const component of entity.components ?? []) {
        if (!component.type.startsWith(`${FORM_SESSION_COMPONENT}:`)) {
          continue;
        }
        if (component.data && isFormSession(component.data)) {
          const session = component.data;
          if (
            isLiveSession(session) &&
            RESTORABLE_SESSION_STATUSES.includes(session.status)
          ) {
            sessionsById.set(session.id, session);
          }
        }
      }
    }

    if (entities.length < RESTORABLE_SESSION_SCAN_LIMIT) {
      break;
    }
    offset += RESTORABLE_SESSION_SCAN_LIMIT;
  }

  return [...sessionsById.values()];
};

// ============================================================================
// SESSION STORAGE
// ============================================================================

/**
 * Get active form session for entity in a specific room.
 *
 * WHY room-scoped:
 * - User might chat in multiple rooms simultaneously
 * - Each room conversation should have its own form context
 * - Discord DM form shouldn't interfere with Telegram form
 *
 * WHY active/ready filter:
 * - Stashed, submitted, cancelled, expired sessions are not "active"
 * - User would need to restore stashed sessions
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @param roomId - The room to check for active session
 * @returns Active session or null if none
 */
export async function getActiveSession(
  runtime: IAgentRuntime,
  entityId: UUID,
  roomId: UUID,
): Promise<FormSession | null> {
  // Session components are now keyed by (roomId, sessionId), so we scan the
  // entity's session components and match on the session's own roomId rather
  // than reading a single room-keyed component. startSession enforces at most
  // one active/ready session per room, so the first match is the active one.
  const components = await runtime.getComponents(entityId);

  for (const component of components) {
    if (!component.type.startsWith(`${FORM_SESSION_COMPONENT}:`)) continue;
    if (!component.data || !isFormSession(component.data)) continue;

    const session = component.data;

    // Only return if active (not stashed, submitted, cancelled, or expired)
    // WHY: Other statuses require explicit action to restore/continue
    if (
      session.roomId === roomId &&
      isLiveSession(session) &&
      (session.status === "active" || session.status === "ready")
    ) {
      return session;
    }
  }

  return null;
}

/**
 * Get all active sessions for an entity (across all rooms).
 *
 * WHY this exists:
 * - For "you have forms in progress" notifications
 * - For session management UI
 * - Not commonly used in normal flow
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @returns Array of active sessions (may be empty)
 */
export async function getAllActiveSessions(
  runtime: IAgentRuntime,
  entityId: UUID,
): Promise<FormSession[]> {
  const components = await runtime.getComponents(entityId);

  const sessions: FormSession[] = [];
  for (const component of components) {
    // Check if this is a form session component
    if (component.type.startsWith(`${FORM_SESSION_COMPONENT}:`)) {
      if (component.data && isFormSession(component.data)) {
        const session = component.data;
        if (
          isLiveSession(session) &&
          (session.status === "active" || session.status === "ready")
        ) {
          sessions.push(session);
        }
      }
    }
  }

  return sessions;
}

/**
 * Get stashed sessions for an entity.
 *
 * WHY stashed is separate from active:
 * - Stashed sessions are "saved for later"
 * - User must explicitly restore them
 * - Different UX from active sessions
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @returns Array of stashed sessions (may be empty)
 */
export async function getStashedSessions(
  runtime: IAgentRuntime,
  entityId: UUID,
): Promise<FormSession[]> {
  const components = await runtime.getComponents(entityId);

  const sessions: FormSession[] = [];
  for (const component of components) {
    if (component.type.startsWith(`${FORM_SESSION_COMPONENT}:`)) {
      if (component.data && isFormSession(component.data)) {
        const session = component.data;
        if (isLiveSession(session) && session.status === "stashed") {
          sessions.push(session);
        }
      }
    }
  }

  return sessions;
}

/**
 * Get a session by ID.
 *
 * WHY by ID:
 * - Needed for operations on specific session
 * - Session ID is stable across room changes
 * - Used by stash/restore when session roomId changes
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @param sessionId - The session ID to find
 * @returns The session or null if not found
 */
export async function getSessionById(
  runtime: IAgentRuntime,
  entityId: UUID,
  sessionId: string,
): Promise<FormSession | null> {
  const components = await runtime.getComponents(entityId);

  for (const component of components) {
    if (component.type.startsWith(`${FORM_SESSION_COMPONENT}:`)) {
      if (component.data && isFormSession(component.data)) {
        const session = component.data;
        if (isLiveSession(session) && session.id === sessionId) {
          return session;
        }
      }
    }
  }

  return null;
}

/**
 * Save a form session.
 *
 * Creates new component if none exists, updates otherwise.
 *
 * WHY upsert pattern:
 * - Session is created once, updated many times
 * - Single function handles both cases
 * - Avoids race conditions
 *
 * @param runtime - Agent runtime for database access
 * @param session - Session to save
 * @param refreshUpdatedAt - Refresh the timestamp on the inert staged snapshot
 */
export async function saveSession(
  runtime: IAgentRuntime,
  session: FormSession,
  refreshUpdatedAt = false,
): Promise<void> {
  const stagedSession = toComponentData(session);
  if (!isFormSessionIdentity(stagedSession)) {
    failComponentData("session-shape");
  }
  if (refreshUpdatedAt) stagedSession.updatedAt = Date.now();
  const componentData = toComponentData(stagedSession);
  if (!isFormSession(componentData)) {
    failComponentData("session-shape");
  }
  const persistedSession = componentData;
  const componentType = sessionComponentType(
    persistedSession.roomId,
    persistedSession.id,
  );
  const existing = await runtime.getComponent(
    persistedSession.entityId,
    componentType,
  );
  const context = await resolveComponentContext(
    runtime,
    persistedSession.roomId,
  );
  const resolvedWorldId = existing?.worldId ?? context.worldId;

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: persistedSession.entityId,
    agentId: runtime.agentId,
    roomId: persistedSession.roomId,
    // WHY preserve worldId: Avoids breaking existing component relationships
    worldId: resolvedWorldId,
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: existing?.createdAt || Date.now(),
    // Store session as component data
    data: componentData,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }

  // Retire any pre-upgrade room-only component for this session so the stale
  // `active` row cannot shadow the freshly written session-id key.
  await retireLegacySessionComponent(runtime, persistedSession);
}

/**
 * Delete a session.
 *
 * WHY delete:
 * - Cleanup after submission/cancellation/expiry
 * - Frees up storage
 * - Note: Usually we just change status instead of deleting
 *
 * @param runtime - Agent runtime for database access
 * @param session - Session to delete
 */
export async function deleteSession(
  runtime: IAgentRuntime,
  session: FormSession,
): Promise<void> {
  const componentType = sessionComponentType(session.roomId, session.id);
  const existing = await runtime.getComponent(session.entityId, componentType);

  if (existing) {
    await runtime.deleteComponent(existing.id);
  }

  // Also remove a pre-upgrade room-only component so deleting a session leaves
  // no ghost row behind under the legacy key.
  await retireLegacySessionComponent(runtime, session);
}

// ============================================================================
// SUBMISSION STORAGE
// ============================================================================

/**
 * Save a form submission.
 *
 * Submissions are immutable records. Always creates new component.
 *
 * WHY new component per submission:
 * - Submissions are immutable
 * - Multiple submissions allowed (if form permits)
 * - Historical record keeping
 *
 * @param runtime - Agent runtime for database access
 * @param submission - Submission to save
 */
export async function saveSubmission(
  runtime: IAgentRuntime,
  submission: FormSubmission,
): Promise<void> {
  const componentData = toComponentData(submission);
  if (!isFormSubmission(componentData)) {
    failComponentData("submission-shape");
  }
  const persistedSubmission = componentData;
  // Use a unique component type per submission
  // WHY: Allows multiple submissions per form
  const componentType = `${FORM_SUBMISSION_COMPONENT}:${persistedSubmission.formId}:${persistedSubmission.id}`;
  const context = await resolveComponentContext(runtime);

  const component: Component = {
    id: uuidv4() as UUID,
    entityId: persistedSubmission.entityId,
    agentId: runtime.agentId,
    roomId: context.roomId,
    worldId: context.worldId,
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: persistedSubmission.submittedAt,
    data: componentData,
  };

  await runtime.createComponent(component);
}

/**
 * Get submissions for an entity, optionally filtered by form ID.
 *
 * WHY optional formId:
 * - List all submissions: no formId
 * - List submissions for specific form: with formId
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @param formId - Optional form ID filter
 * @returns Array of submissions, newest first
 */
export async function getSubmissions(
  runtime: IAgentRuntime,
  entityId: UUID,
  formId?: string,
): Promise<FormSubmission[]> {
  const components = await runtime.getComponents(entityId);

  const submissions: FormSubmission[] = [];
  const prefix = formId
    ? `${FORM_SUBMISSION_COMPONENT}:${formId}:`
    : `${FORM_SUBMISSION_COMPONENT}:`;

  for (const component of components) {
    if (component.type.startsWith(prefix)) {
      if (component.data && isFormSubmission(component.data)) {
        submissions.push(component.data);
      }
    }
  }

  // Sort by submission time, newest first
  // WHY: Most recent submissions are usually most relevant
  submissions.sort((a, b) => {
    const bTime =
      typeof b.submittedAt === "number" && Number.isFinite(b.submittedAt)
        ? b.submittedAt
        : 0;
    const aTime =
      typeof a.submittedAt === "number" && Number.isFinite(a.submittedAt)
        ? a.submittedAt
        : 0;
    return bTime - aTime || a.id.localeCompare(b.id);
  });

  return submissions;
}

/**
 * Get a specific submission by ID.
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @param submissionId - The submission ID to find
 * @returns The submission or null if not found
 */
export async function getSubmissionById(
  runtime: IAgentRuntime,
  entityId: UUID,
  submissionId: string,
): Promise<FormSubmission | null> {
  const components = await runtime.getComponents(entityId);

  for (const component of components) {
    if (component.type.startsWith(`${FORM_SUBMISSION_COMPONENT}:`)) {
      if (component.data && isFormSubmission(component.data)) {
        const submission = component.data;
        if (submission.id === submissionId) {
          return submission;
        }
      }
    }
  }

  return null;
}

// ============================================================================
// AUTOFILL STORAGE
// ============================================================================

/**
 * Get autofill data for a user's form.
 *
 * WHY autofill:
 * - Users filling repeat forms want saved values
 * - Reduces friction for common fields (name, email, address)
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @param formId - Form definition ID
 * @returns Autofill data or null if none saved
 */
export async function getAutofillData(
  runtime: IAgentRuntime,
  entityId: UUID,
  formId: string,
): Promise<FormAutofillData | null> {
  const componentType = `${FORM_AUTOFILL_COMPONENT}:${formId}`;
  const component = await runtime.getComponent(entityId, componentType);

  if (!component?.data || !isFormAutofillData(component.data)) return null;

  return component.data;
}

/**
 * Save autofill data for a user's form.
 *
 * Overwrites existing autofill data for the form.
 *
 * WHY overwrite:
 * - Most recent submission has most current data
 * - User's email might have changed
 * - Only one autofill record per form needed
 *
 * @param runtime - Agent runtime for database access
 * @param entityId - User's entity ID
 * @param formId - Form definition ID
 * @param values - Field values to save for autofill
 */
export async function saveAutofillData(
  runtime: IAgentRuntime,
  entityId: UUID,
  formId: string,
  values: Record<string, JsonValue>,
): Promise<void> {
  const componentData = toComponentData({
    formId,
    values,
    updatedAt: Date.now(),
  });
  if (!isFormAutofillData(componentData)) {
    failComponentData("autofill-shape");
  }
  const componentType = `${FORM_AUTOFILL_COMPONENT}:${formId}`;
  const existing = await runtime.getComponent(entityId, componentType);
  const context = await resolveComponentContext(runtime);
  const resolvedWorldId = existing?.worldId ?? context.worldId;

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId,
    agentId: runtime.agentId,
    roomId: context.roomId,
    worldId: resolvedWorldId,
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: existing?.createdAt || Date.now(),
    data: componentData,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

/**
 * Get all stale sessions (for nudge system).
 *
 * WHY this is here:
 * - Finds active/ready/stashed sessions across users
 * - Uses a bounded entity scan so remote runtimes do not need to support
 *   component-data filtering
 * - Filters by the typed session payload so unrelated components with
 *   matching status values are ignored
 *
 * @param runtime - Agent runtime for database access
 * @param afterInactiveMs - Inactivity threshold in milliseconds
 * @returns Array of stale sessions
 */
export async function getStaleSessions(
  runtime: IAgentRuntime,
  afterInactiveMs: number,
): Promise<FormSession[]> {
  const now = Date.now();
  const sessions = await getRestorableSessions(runtime);
  return sessions.filter(
    (session) => now - session.effort.lastInteractionAt >= afterInactiveMs,
  );
}

/**
 * Get sessions expiring within a time window.
 *
 * Same bounded-scan limitation as getStaleSessions.
 *
 * @param runtime - Agent runtime for database access
 * @param withinMs - Time window in milliseconds
 * @returns Array of expiring sessions
 */
export async function getExpiringSessions(
  runtime: IAgentRuntime,
  withinMs: number,
): Promise<FormSession[]> {
  const sessions = await getRestorableSessions(runtime);
  return sessions.filter((session) => isExpiringSoon(session, withinMs));
}
