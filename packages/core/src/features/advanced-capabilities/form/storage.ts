/**
 * @module storage
 * @description Component-based persistence for form data
 *
 * Form data is stored using elizaOS's Component system because:
 * 1. Entity-Scoped: Components belong to entities (users)
 * 2. Typed Storage: Component type field allows different kinds of form data
 * 3. No Custom Schema: Uses existing elizaOS infrastructure
 * 4. Room Scoping: Component type includes roomId for session isolation
 */

import { v4 as uuidv4 } from "uuid";
import type {
	Component,
	IAgentRuntime,
	JsonValue,
	UUID,
} from "../../../types/index.ts";
import type { FormAutofillData, FormSession, FormSubmission } from "./types.ts";
import {
	FORM_AUTOFILL_COMPONENT,
	FORM_SESSION_COMPONENT,
	FORM_SUBMISSION_COMPONENT,
} from "./types.ts";

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

export async function getActiveSession(
	runtime: IAgentRuntime,
	entityId: UUID,
	roomId: UUID,
): Promise<FormSession | null> {
	const component = await runtime.getComponent(
		entityId,
		`${FORM_SESSION_COMPONENT}:${roomId}`,
	);

	if (!component?.data || !isFormSession(component.data)) return null;

	const session = component.data;

	if (session.status === "active" || session.status === "ready") {
		return session;
	}

	return null;
}

export async function getAllActiveSessions(
	runtime: IAgentRuntime,
	entityId: UUID,
): Promise<FormSession[]> {
	const components = await runtime.getComponents(entityId);

	const sessions: FormSession[] = [];
	for (const component of components) {
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
		worldId: resolvedWorldId,
		sourceEntityId: runtime.agentId,
		type: componentType,
		createdAt: existing?.createdAt || Date.now(),
		data: JSON.parse(JSON.stringify(session)) as Record<string, JsonValue>,
	};

	if (existing) {
		await runtime.updateComponent(component);
	} else {
		await runtime.createComponent(component);
	}
}

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

export async function saveSubmission(
	runtime: IAgentRuntime,
	submission: FormSubmission,
): Promise<void> {
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

	submissions.sort((a, b) => b.submittedAt - a.submittedAt);

	return submissions;
}

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

export async function getStaleSessions(
	runtime: IAgentRuntime,
	_afterInactiveMs: number,
): Promise<FormSession[]> {
	runtime.logger.warn(
		"getStaleSessions requires entity iteration - not implemented",
	);
	return [];
}

export async function getExpiringSessions(
	runtime: IAgentRuntime,
	_withinMs: number,
): Promise<FormSession[]> {
	runtime.logger.warn(
		"getExpiringSessions requires entity iteration - not implemented",
	);
	return [];
}
