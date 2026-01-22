/**
 * @module storage
 * @description Component-based persistence for form data
 *
 * ## Design Rationale
 *
 * Form data is stored using ElizaOS's Component system because:
 *
 * 1. **Entity-Scoped**: Components belong to entities (users).
 *    This naturally scopes form data per-user.
 *
 * 2. **Typed Storage**: Component type field allows different kinds
 *    of form data (sessions, submissions, autofill).
 *
 * 3. **No Custom Schema**: Uses existing ElizaOS infrastructure,
 *    no need to create database tables.
 *
 * 4. **Room Scoping**: Component type includes roomId for session
 *    isolation across rooms.
 *
 * ## Storage Strategy
 *
 * ### Sessions
 * - Stored as components with type: `form_session:{roomId}`
 * - One active session per user per room
 * - Scoping ensures different rooms have different contexts
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
 * ## Limitations
 *
 * The current implementation has limitations:
 *
 * 1. **No Cross-Entity Queries**: Can't efficiently find all stale
 *    sessions across all users. This affects nudge system.
 *
 * 2. **No Indexes**: Component queries are sequential scans.
 *    For high-volume usage, consider database-level optimizations.
 *
 * These are acceptable for v1 but noted for future improvement.
 */

import type { Component, IAgentRuntime, JsonValue, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { FormSession, FormSubmission, FormAutofillData } from "./types";
import {
  FORM_SESSION_COMPONENT,
  FORM_SUBMISSION_COMPONENT,
  FORM_AUTOFILL_COMPONENT,
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

const isFormSession = (data: JsonValue | object): data is FormSession => {
  if (!isRecord(data)) return false;
  return (
    typeof data.id === "string" &&
    typeof data.formId === "string" &&
    typeof data.entityId === "string" &&
    typeof data.roomId === "string"
  );
};

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
  // Component type includes roomId for room-level scoping
  const component = await runtime.getComponent(
    entityId,
    `${FORM_SESSION_COMPONENT}:${roomId}`,
  );

  if (!component?.data || !isFormSession(component.data)) return null;

  const session = component.data;

  // Only return if active (not stashed, submitted, cancelled, or expired)
  // WHY: Other statuses require explicit action to restore/continue
  if (session.status === "active" || session.status === "ready") {
    return session;
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
        if (session.status === "active" || session.status === "ready") {
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
        if (session.status === "stashed") {
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
        if (session.id === sessionId) {
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
 */
export async function saveSession(
  runtime: IAgentRuntime,
  session: FormSession,
): Promise<void> {
  const componentType = `${FORM_SESSION_COMPONENT}:${session.roomId}`;
  const existing = await runtime.getComponent(session.entityId, componentType);
  const context = await resolveComponentContext(runtime, session.roomId);
  const resolvedWorldId = existing?.worldId ?? context.worldId;

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: session.entityId,
    agentId: runtime.agentId,
    roomId: session.roomId,
    // WHY preserve worldId: Avoids breaking existing component relationships
    worldId: resolvedWorldId,
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: existing?.createdAt || Date.now(),
    // Store session as component data
    data: JSON.parse(JSON.stringify(session)) as Record<string, JsonValue>,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }
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
  const componentType = `${FORM_SESSION_COMPONENT}:${session.roomId}`;
  const existing = await runtime.getComponent(session.entityId, componentType);

  if (existing) {
    await runtime.deleteComponent(existing.id);
  }
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
  // Use a unique component type per submission
  // WHY: Allows multiple submissions per form
  const componentType = `${FORM_SUBMISSION_COMPONENT}:${submission.formId}:${submission.id}`;
  const context = await resolveComponentContext(runtime);

  const component: Component = {
    id: uuidv4() as UUID,
    entityId: submission.entityId,
    agentId: runtime.agentId,
    roomId: context.roomId,
    worldId: context.worldId,
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: submission.submittedAt,
    data: JSON.parse(JSON.stringify(submission)) as Record<string, JsonValue>,
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
  submissions.sort((a, b) => b.submittedAt - a.submittedAt);

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
  const componentType = `${FORM_AUTOFILL_COMPONENT}:${formId}`;
  const existing = await runtime.getComponent(entityId, componentType);
  const context = await resolveComponentContext(runtime);
  const resolvedWorldId = existing?.worldId ?? context.worldId;

  const data: FormAutofillData = {
    formId,
    values,
    updatedAt: Date.now(),
  };

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId,
    agentId: runtime.agentId,
    roomId: context.roomId,
    worldId: resolvedWorldId,
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: existing?.createdAt || Date.now(),
    data: JSON.parse(JSON.stringify(data)) as Record<string, JsonValue>,
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
 * LIMITATION: This requires iterating over all entities, which is not
 * efficient with current ElizaOS component system. In production,
 * this would need a database-level query.
 *
 * WHY this is here:
 * - Documents the need for this functionality
 * - Placeholder for future implementation
 * - Nudge system can call this when entity context is available
 *
 * @param runtime - Agent runtime for database access
 * @param afterInactiveMs - Inactivity threshold in milliseconds
 * @returns Array of stale sessions (currently returns empty array)
 */
export async function getStaleSessions(
  runtime: IAgentRuntime,
  afterInactiveMs: number,
): Promise<FormSession[]> {
  // TODO: Implement proper querying across all entities
  // This would require either:
  // 1. A database index on component data
  // 2. A separate tracking table
  // 3. Periodic full scan (expensive)

  runtime.logger.warn(
    "getStaleSessions requires entity iteration - not implemented",
  );
  return [];
}

/**
 * Get sessions expiring within a time window.
 *
 * Same limitation as getStaleSessions.
 *
 * @param runtime - Agent runtime for database access
 * @param withinMs - Time window in milliseconds
 * @returns Array of expiring sessions (currently returns empty array)
 */
export async function getExpiringSessions(
  runtime: IAgentRuntime,
  withinMs: number,
): Promise<FormSession[]> {
  runtime.logger.warn(
    "getExpiringSessions requires entity iteration - not implemented",
  );
  return [];
}
