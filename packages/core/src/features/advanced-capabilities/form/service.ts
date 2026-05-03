/**
 * @module service
 * @description Central service for managing agent-guided user journeys
 *
 * The FormService is the journey controller. It ensures agents stay on
 * the path defined by form definitions, guiding users reliably to outcomes.
 */

import { v4 as uuidv4 } from "uuid";
import {
	type EventPayload,
	type IAgentRuntime,
	type JsonValue,
	logger,
	type Task,
	type UUID,
} from "../../../types/index.ts";
import { Service } from "../../../types/service.ts";
import { registerBuiltinTypes } from "./builtins.ts";
import {
	getAutofillData,
	getSessionById,
	saveAutofillData,
	saveSubmission,
	getActiveSession as storageGetActiveSession,
	getAllActiveSessions as storageGetAllActiveSessions,
	getStashedSessions as storageGetStashedSessions,
	getSubmissions as storageGetSubmissions,
	saveSession as storageSaveSession,
} from "./storage.ts";
import type {
	ActivationContext,
	ControlType,
	ExternalActivation,
	FieldHistoryEntry,
	FieldState,
	FilledFieldSummary,
	FormContextState,
	FormControl,
	FormDefinition,
	FormSession,
	FormSubmission,
	MissingFieldSummary,
	PendingExternalFieldSummary,
	UncertainFieldSummary,
} from "./types.ts";
import { FORM_CONTROL_DEFAULTS, FORM_DEFINITION_DEFAULTS } from "./types.ts";
import { formatValue, validateField } from "./validation.ts";

// ============================================================================
// FORM SERVICE
// ============================================================================

export class FormService extends Service {
	static serviceType = "FORM";

	capabilityDescription = "Manages conversational forms for data collection";

	private forms: Map<string, FormDefinition> = new Map();
	private controlTypes: Map<string, ControlType> = new Map();

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new FormService(runtime);

		registerBuiltinTypes((type, options) =>
			service.registerControlType(type, options),
		);

		logger.info("[FormService] Started with built-in types");
		return service;
	}

	async stop(): Promise<void> {
		logger.info("[FormService] Stopped");
	}

	// ============================================================================
	// FORM DEFINITION MANAGEMENT
	// ============================================================================

	registerForm(definition: FormDefinition): void {
		const form: FormDefinition = {
			...definition,
			version: definition.version ?? FORM_DEFINITION_DEFAULTS.version,
			status: definition.status ?? FORM_DEFINITION_DEFAULTS.status,
			ux: { ...FORM_DEFINITION_DEFAULTS.ux, ...definition.ux },
			ttl: { ...FORM_DEFINITION_DEFAULTS.ttl, ...definition.ttl },
			nudge: { ...FORM_DEFINITION_DEFAULTS.nudge, ...definition.nudge },
			debug: definition.debug ?? FORM_DEFINITION_DEFAULTS.debug,
			controls: definition.controls.map((control) => ({
				...control,
				type: control.type || FORM_CONTROL_DEFAULTS.type,
				required: control.required ?? FORM_CONTROL_DEFAULTS.required,
				confirmThreshold:
					control.confirmThreshold ?? FORM_CONTROL_DEFAULTS.confirmThreshold,
				label: control.label || prettify(control.key),
			})),
		};

		this.forms.set(form.id, form);
		logger.debug(`[FormService] Registered form: ${form.id}`);
	}

	getForm(formId: string): FormDefinition | undefined {
		return this.forms.get(formId);
	}

	listForms(): FormDefinition[] {
		return Array.from(this.forms.values());
	}

	// ============================================================================
	// CONTROL TYPE REGISTRY
	// ============================================================================

	registerControlType(
		type: ControlType,
		options?: { allowOverride?: boolean },
	): void {
		const existing = this.controlTypes.get(type.id);

		if (existing) {
			if (existing.builtin && !options?.allowOverride) {
				logger.warn(
					`[FormService] Cannot override builtin type '${type.id}' without allowOverride: true`,
				);
				return;
			}
			logger.warn(`[FormService] Overriding control type: ${type.id}`);
		}

		this.controlTypes.set(type.id, type);
		logger.debug(`[FormService] Registered control type: ${type.id}`);
	}

	getControlType(typeId: string): ControlType | undefined {
		return this.controlTypes.get(typeId);
	}

	listControlTypes(): ControlType[] {
		return Array.from(this.controlTypes.values());
	}

	isCompositeType(typeId: string): boolean {
		const type = this.controlTypes.get(typeId);
		return !!type?.getSubControls;
	}

	isExternalType(typeId: string): boolean {
		const type = this.controlTypes.get(typeId);
		return !!type?.activate;
	}

	getSubControls(control: FormControl): FormControl[] {
		const type = this.controlTypes.get(control.type);
		if (!type?.getSubControls) {
			return [];
		}
		return type.getSubControls(control, this.runtime);
	}

	// ============================================================================
	// SESSION MANAGEMENT
	// ============================================================================

	async startSession(
		formId: string,
		entityId: UUID,
		roomId: UUID,
		options?: {
			context?: Record<string, JsonValue>;
			initialValues?: Record<string, JsonValue>;
			locale?: string;
		},
	): Promise<FormSession> {
		const form = this.getForm(formId);
		if (!form) {
			throw new Error(`Form not found: ${formId}`);
		}

		const existing = await storageGetActiveSession(
			this.runtime,
			entityId,
			roomId,
		);
		if (existing) {
			throw new Error(
				`Active session already exists for this user/room: ${existing.id}`,
			);
		}

		const now = Date.now();

		const fields: Record<string, FieldState> = {};
		for (const control of form.controls) {
			if (options?.initialValues?.[control.key] !== undefined) {
				fields[control.key] = {
					status: "filled",
					value: options.initialValues[control.key],
					source: "manual",
					updatedAt: now,
				};
			} else if (control.defaultValue !== undefined) {
				fields[control.key] = {
					status: "filled",
					value: control.defaultValue,
					source: "default",
					updatedAt: now,
				};
			} else {
				fields[control.key] = { status: "empty" };
			}
		}

		const ttlDays = form.ttl?.minDays ?? 14;
		const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

		const session: FormSession = {
			id: uuidv4(),
			formId,
			formVersion: form.version,
			entityId,
			roomId,
			status: "active",
			fields,
			history: [],
			context: options?.context,
			locale: options?.locale,
			effort: {
				interactionCount: 0,
				timeSpentMs: 0,
				firstInteractionAt: now,
				lastInteractionAt: now,
			},
			expiresAt,
			createdAt: now,
			updatedAt: now,
		};

		await storageSaveSession(this.runtime, session);

		if (form.hooks?.onStart) {
			await this.executeHook(session, "onStart");
		}

		logger.debug(
			`[FormService] Started session ${session.id} for form ${formId}`,
		);

		return session;
	}

	async getActiveSession(
		entityId: UUID,
		roomId: UUID,
	): Promise<FormSession | null> {
		return storageGetActiveSession(this.runtime, entityId, roomId);
	}

	async getAllActiveSessions(entityId: UUID): Promise<FormSession[]> {
		return storageGetAllActiveSessions(this.runtime, entityId);
	}

	async getStashedSessions(entityId: UUID): Promise<FormSession[]> {
		return storageGetStashedSessions(this.runtime, entityId);
	}

	async saveSession(session: FormSession): Promise<void> {
		session.updatedAt = Date.now();
		await storageSaveSession(this.runtime, session);
	}

	// ============================================================================
	// FIELD UPDATES
	// ============================================================================

	async updateField(
		sessionId: string,
		entityId: UUID,
		field: string,
		value: JsonValue,
		confidence: number,
		source: FieldState["source"],
		messageId?: string,
	): Promise<void> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const form = this.getForm(session.formId);
		if (!form) {
			throw new Error(`Form not found: ${session.formId}`);
		}

		const control = form.controls.find((c) => c.key === field);
		if (!control) {
			throw new Error(`Field not found: ${field}`);
		}

		const oldValue = session.fields[field]?.value;
		const validation = validateField(value, control);

		let status: FieldState["status"];
		if (!validation.valid) {
			status = "invalid";
		} else if (confidence < (control.confirmThreshold ?? 0.8)) {
			status = "uncertain";
		} else {
			status = "filled";
		}

		const now = Date.now();

		if (oldValue !== undefined) {
			const historyEntry: FieldHistoryEntry = {
				field,
				oldValue,
				newValue: value,
				timestamp: now,
			};
			session.history.push(historyEntry);

			const maxUndo = form.ux?.maxUndoSteps ?? 5;
			if (session.history.length > maxUndo) {
				session.history = session.history.slice(-maxUndo);
			}
		}

		session.fields[field] = {
			status,
			value,
			confidence,
			source,
			messageId,
			updatedAt: now,
			error: !validation.valid ? validation.error : undefined,
		};

		session.effort.interactionCount++;
		session.effort.lastInteractionAt = now;
		session.effort.timeSpentMs = now - session.effort.firstInteractionAt;

		session.expiresAt = this.calculateTTL(session);

		const allRequiredFilled = this.checkAllRequiredFilled(session, form);
		if (allRequiredFilled && session.status === "active") {
			session.status = "ready";
			if (form.hooks?.onReady) {
				await this.executeHook(session, "onReady");
			}
		}

		session.updatedAt = now;
		await storageSaveSession(this.runtime, session);

		if (form.hooks?.onFieldChange) {
			const hookPayload: Record<string, JsonValue> = { field, value };
			if (oldValue !== undefined) {
				hookPayload.oldValue = oldValue;
			}
			await this.executeHook(session, "onFieldChange", hookPayload);
		}
	}

	async undoLastChange(
		sessionId: string,
		entityId: UUID,
	): Promise<{ field: string; restoredValue: JsonValue } | null> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const form = this.getForm(session.formId);
		if (!form?.ux?.allowUndo) {
			return null;
		}

		const lastChange = session.history.pop();
		if (!lastChange) {
			return null;
		}

		if (lastChange.oldValue !== undefined) {
			session.fields[lastChange.field] = {
				status: "filled",
				value: lastChange.oldValue,
				source: "correction",
				updatedAt: Date.now(),
			};
		} else {
			session.fields[lastChange.field] = { status: "empty" };
		}

		session.updatedAt = Date.now();
		await storageSaveSession(this.runtime, session);

		return { field: lastChange.field, restoredValue: lastChange.oldValue };
	}

	async skipField(
		sessionId: string,
		entityId: UUID,
		field: string,
	): Promise<boolean> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const form = this.getForm(session.formId);
		if (!form?.ux?.allowSkip) {
			return false;
		}

		const control = form.controls.find((c) => c.key === field);
		if (!control) {
			return false;
		}

		if (control.required) {
			return false;
		}

		session.fields[field] = {
			status: "skipped",
			updatedAt: Date.now(),
		};

		session.updatedAt = Date.now();
		await storageSaveSession(this.runtime, session);

		return true;
	}

	async confirmField(
		sessionId: string,
		entityId: UUID,
		field: string,
		accepted: boolean,
	): Promise<void> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const fieldState = session.fields[field];
		if (!fieldState || fieldState.status !== "uncertain") {
			return;
		}

		const now = Date.now();

		if (accepted) {
			fieldState.status = "filled";
			fieldState.confirmedAt = now;
		} else {
			fieldState.status = "empty";
			fieldState.value = undefined;
			fieldState.confidence = undefined;
		}

		fieldState.updatedAt = now;
		session.updatedAt = now;
		await storageSaveSession(this.runtime, session);
	}

	// ============================================================================
	// SUBFIELD UPDATES (for composite types)
	// ============================================================================

	async updateSubField(
		sessionId: string,
		entityId: UUID,
		parentField: string,
		subField: string,
		value: JsonValue,
		confidence: number,
		messageId?: string,
	): Promise<void> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const form = this.getForm(session.formId);
		if (!form) {
			throw new Error(`Form not found: ${session.formId}`);
		}

		const parentControl = form.controls.find((c) => c.key === parentField);
		if (!parentControl) {
			throw new Error(`Parent field not found: ${parentField}`);
		}

		const controlType = this.getControlType(parentControl.type);
		if (!controlType?.getSubControls) {
			throw new Error(
				`Control type '${parentControl.type}' is not a composite type`,
			);
		}

		const subControls = controlType.getSubControls(parentControl, this.runtime);
		const subControl = subControls.find((c) => c.key === subField);
		if (!subControl) {
			throw new Error(`Subfield not found: ${subField} in ${parentField}`);
		}

		const now = Date.now();

		if (!session.fields[parentField]) {
			session.fields[parentField] = { status: "empty" };
		}
		if (!session.fields[parentField].subFields) {
			session.fields[parentField].subFields = {};
		}

		let subFieldStatus: FieldState["status"];
		let error: string | undefined;

		if (controlType.validate) {
			const result = controlType.validate(value, subControl);
			if (!result.valid) {
				subFieldStatus = "invalid";
				error = result.error;
			} else if (confidence < (subControl.confirmThreshold ?? 0.8)) {
				subFieldStatus = "uncertain";
			} else {
				subFieldStatus = "filled";
			}
		} else {
			const validation = validateField(value, subControl);
			if (!validation.valid) {
				subFieldStatus = "invalid";
				error = validation.error;
			} else if (confidence < (subControl.confirmThreshold ?? 0.8)) {
				subFieldStatus = "uncertain";
			} else {
				subFieldStatus = "filled";
			}
		}

		session.fields[parentField].subFields[subField] = {
			status: subFieldStatus,
			value,
			confidence,
			source: "extraction",
			messageId,
			updatedAt: now,
			error,
		};

		session.effort.interactionCount++;
		session.effort.lastInteractionAt = now;
		session.effort.timeSpentMs = now - session.effort.firstInteractionAt;

		session.updatedAt = now;
		await storageSaveSession(this.runtime, session);

		logger.debug(`[FormService] Updated subfield ${parentField}.${subField}`);
	}

	areSubFieldsFilled(session: FormSession, parentField: string): boolean {
		const form = this.getForm(session.formId);
		if (!form) return false;

		const parentControl = form.controls.find((c) => c.key === parentField);
		if (!parentControl) return false;

		const controlType = this.getControlType(parentControl.type);
		if (!controlType?.getSubControls) return false;

		const subControls = controlType.getSubControls(parentControl, this.runtime);
		const subFields = session.fields[parentField]?.subFields || {};

		for (const subControl of subControls) {
			if (!subControl.required) continue;
			const subFieldState = subFields[subControl.key];
			if (!subFieldState || subFieldState.status !== "filled") {
				return false;
			}
		}

		return true;
	}

	getSubFieldValues(
		session: FormSession,
		parentField: string,
	): Record<string, JsonValue> {
		const subFields = session.fields[parentField]?.subFields || {};
		const values: Record<string, JsonValue> = {};
		for (const [key, state] of Object.entries(subFields)) {
			if (state.value !== undefined) {
				values[key] = state.value;
			}
		}
		return values;
	}

	// ============================================================================
	// EXTERNAL FIELD ACTIVATION
	// ============================================================================

	async activateExternalField(
		sessionId: string,
		entityId: UUID,
		field: string,
	): Promise<ExternalActivation> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const form = this.getForm(session.formId);
		if (!form) {
			throw new Error(`Form not found: ${session.formId}`);
		}

		const control = form.controls.find((c) => c.key === field);
		if (!control) {
			throw new Error(`Field not found: ${field}`);
		}

		const controlType = this.getControlType(control.type);
		if (!controlType?.activate) {
			throw new Error(
				`Control type '${control.type}' does not support activation`,
			);
		}

		const subValues = this.getSubFieldValues(session, field);

		const context: ActivationContext = {
			runtime: this.runtime,
			session,
			control,
			subValues,
		};

		const activation = await controlType.activate(context);

		const now = Date.now();

		if (!session.fields[field]) {
			session.fields[field] = { status: "empty" };
		}

		session.fields[field].status = "pending";
		session.fields[field].externalState = {
			status: "pending",
			reference: activation.reference,
			instructions: activation.instructions,
			address: activation.address,
			activatedAt: now,
		};

		session.updatedAt = now;
		await storageSaveSession(this.runtime, session);

		logger.info(
			`[FormService] Activated external field ${field} with reference ${activation.reference}`,
		);

		return activation;
	}

	async confirmExternalField(
		sessionId: string,
		entityId: UUID,
		field: string,
		value: JsonValue,
		externalData?: Record<string, JsonValue>,
	): Promise<void> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const fieldState = session.fields[field];
		if (!fieldState || fieldState.status !== "pending") {
			logger.warn(
				`[FormService] Cannot confirm field ${field}: not in pending state`,
			);
			return;
		}

		const now = Date.now();

		fieldState.status = "filled";
		fieldState.value = value;
		fieldState.source = "external";
		fieldState.updatedAt = now;

		if (fieldState.externalState) {
			fieldState.externalState.status = "confirmed";
			fieldState.externalState.confirmedAt = now;
			fieldState.externalState.externalData = externalData;
		}

		const form = this.getForm(session.formId);
		if (form && this.checkAllRequiredFilled(session, form)) {
			if (session.status === "active") {
				session.status = "ready";
				if (form.hooks?.onReady) {
					await this.executeHook(session, "onReady");
				}
			}
		}

		session.updatedAt = now;
		await storageSaveSession(this.runtime, session);

		try {
			await this.runtime.emitEvent("FORM_FIELD_CONFIRMED", {
				runtime: this.runtime,
				sessionId,
				entityId,
				field,
				value,
				externalData,
			} as EventPayload);
		} catch (_error) {
			logger.debug(`[FormService] No event handler for FORM_FIELD_CONFIRMED`);
		}

		logger.info(`[FormService] Confirmed external field ${field}`);
	}

	async cancelExternalField(
		sessionId: string,
		entityId: UUID,
		field: string,
		reason: string,
	): Promise<void> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const form = this.getForm(session.formId);
		const control = form?.controls.find((c) => c.key === field);
		const controlType = control ? this.getControlType(control.type) : undefined;

		if (controlType?.deactivate && control) {
			try {
				await controlType.deactivate({
					runtime: this.runtime,
					session,
					control,
					subValues: this.getSubFieldValues(session, field),
				});
			} catch (error) {
				logger.error(
					`[FormService] Deactivate failed for ${field}: ${String(error)}`,
				);
			}
		}

		const fieldState = session.fields[field];
		if (fieldState) {
			fieldState.status = "empty";
			fieldState.error = reason;
			if (fieldState.externalState) {
				fieldState.externalState.status = "failed";
			}
		}

		session.updatedAt = Date.now();
		await storageSaveSession(this.runtime, session);

		try {
			await this.runtime.emitEvent("FORM_FIELD_CANCELLED", {
				runtime: this.runtime,
				sessionId,
				entityId,
				field,
				reason,
			} as EventPayload);
		} catch (_error) {
			logger.debug(`[FormService] No event handler for FORM_FIELD_CANCELLED`);
		}

		logger.info(`[FormService] Cancelled external field ${field}: ${reason}`);
	}

	// ============================================================================
	// LIFECYCLE
	// ============================================================================

	async submit(sessionId: string, entityId: UUID): Promise<FormSubmission> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const form = this.getForm(session.formId);
		if (!form) {
			throw new Error(`Form not found: ${session.formId}`);
		}

		if (!this.checkAllRequiredFilled(session, form)) {
			throw new Error("Not all required fields are filled");
		}

		const now = Date.now();

		const values: Record<string, JsonValue> = {};
		const mappedValues: Record<string, JsonValue> = {};
		const files: Record<string, NonNullable<FieldState["files"]>> = {};

		for (const control of form.controls) {
			const fieldState = session.fields[control.key];
			if (fieldState?.value !== undefined) {
				values[control.key] = fieldState.value;
				const dbKey = control.dbbind || control.key;
				mappedValues[dbKey] = fieldState.value;
			}
			if (fieldState?.files) {
				files[control.key] = fieldState.files;
			}
		}

		const submission: FormSubmission = {
			id: uuidv4(),
			formId: session.formId,
			formVersion: session.formVersion,
			sessionId: session.id,
			entityId: session.entityId,
			values,
			mappedValues,
			files: Object.keys(files).length > 0 ? files : undefined,
			submittedAt: now,
			meta: session.meta,
		};

		await saveSubmission(this.runtime, submission);
		await saveAutofillData(this.runtime, entityId, session.formId, values);

		session.status = "submitted";
		session.submittedAt = now;
		session.updatedAt = now;
		await storageSaveSession(this.runtime, session);

		if (form.hooks?.onSubmit) {
			const submissionPayload = JSON.parse(
				JSON.stringify(submission),
			) as JsonValue;
			await this.executeHook(session, "onSubmit", {
				submission: submissionPayload,
			});
		}

		logger.debug(`[FormService] Submitted session ${sessionId}`);

		return submission;
	}

	async stash(sessionId: string, entityId: UUID): Promise<void> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		session.status = "stashed";
		session.updatedAt = Date.now();
		await storageSaveSession(this.runtime, session);

		logger.debug(`[FormService] Stashed session ${sessionId}`);
	}

	async restore(sessionId: string, entityId: UUID): Promise<FormSession> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		if (session.status !== "stashed") {
			throw new Error(`Session is not stashed: ${session.status}`);
		}

		const existing = await storageGetActiveSession(
			this.runtime,
			entityId,
			session.roomId,
		);
		if (existing && existing.id !== sessionId) {
			throw new Error(`Active session already exists in room: ${existing.id}`);
		}

		session.status = "active";
		session.updatedAt = Date.now();
		session.expiresAt = this.calculateTTL(session);

		await storageSaveSession(this.runtime, session);

		logger.debug(`[FormService] Restored session ${sessionId}`);

		return session;
	}

	async cancel(
		sessionId: string,
		entityId: UUID,
		force = false,
	): Promise<boolean> {
		const session = await getSessionById(this.runtime, entityId, sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		if (
			!force &&
			this.shouldConfirmCancel(session) &&
			!session.cancelConfirmationAsked
		) {
			session.cancelConfirmationAsked = true;
			session.updatedAt = Date.now();
			await storageSaveSession(this.runtime, session);
			return false;
		}

		const form = this.getForm(session.formId);

		session.status = "cancelled";
		session.updatedAt = Date.now();
		await storageSaveSession(this.runtime, session);

		if (form?.hooks?.onCancel) {
			await this.executeHook(session, "onCancel");
		}

		logger.debug(`[FormService] Cancelled session ${sessionId}`);

		return true;
	}

	// ============================================================================
	// SUBMISSIONS
	// ============================================================================

	async getSubmissions(
		entityId: UUID,
		formId?: string,
	): Promise<FormSubmission[]> {
		return storageGetSubmissions(this.runtime, entityId, formId);
	}

	// ============================================================================
	// AUTOFILL
	// ============================================================================

	async getAutofill(
		entityId: UUID,
		formId: string,
	): Promise<Record<string, JsonValue> | null> {
		const data = await getAutofillData(this.runtime, entityId, formId);
		return data?.values || null;
	}

	async applyAutofill(session: FormSession): Promise<string[]> {
		const form = this.getForm(session.formId);
		if (!form?.ux?.allowAutofill) {
			return [];
		}

		const autofill = await getAutofillData(
			this.runtime,
			session.entityId,
			session.formId,
		);
		if (!autofill) {
			return [];
		}

		const appliedFields: string[] = [];
		const now = Date.now();

		for (const control of form.controls) {
			if (session.fields[control.key]?.status !== "empty") {
				continue;
			}

			const value = autofill.values[control.key];
			if (value !== undefined) {
				session.fields[control.key] = {
					status: "filled",
					value,
					source: "autofill",
					updatedAt: now,
				};
				appliedFields.push(control.key);
			}
		}

		if (appliedFields.length > 0) {
			session.updatedAt = now;
			await storageSaveSession(this.runtime, session);
		}

		return appliedFields;
	}

	// ============================================================================
	// CONTEXT HELPERS
	// ============================================================================

	getSessionContext(session: FormSession): FormContextState {
		const form = this.getForm(session.formId);
		if (!form) {
			return {
				hasActiveForm: false,
				progress: 0,
				filledFields: [],
				missingRequired: [],
				uncertainFields: [],
				nextField: null,
				pendingExternalFields: [],
			};
		}

		const filledFields: FilledFieldSummary[] = [];
		const missingRequired: MissingFieldSummary[] = [];
		const uncertainFields: UncertainFieldSummary[] = [];
		const pendingExternalFields: PendingExternalFieldSummary[] = [];
		let nextField: FormControl | null = null;

		let filledCount = 0;
		let totalRequired = 0;

		for (const control of form.controls) {
			if (control.hidden) continue;

			const fieldState = session.fields[control.key];

			if (control.required) {
				totalRequired++;
			}

			if (fieldState?.status === "filled") {
				filledCount++;
				filledFields.push({
					key: control.key,
					label: control.label,
					displayValue: formatValue(fieldState.value ?? null, control),
				});
			} else if (fieldState?.status === "pending") {
				if (fieldState.externalState) {
					pendingExternalFields.push({
						key: control.key,
						label: control.label,
						instructions:
							fieldState.externalState.instructions ||
							"Waiting for confirmation...",
						reference: fieldState.externalState.reference || "",
						activatedAt: fieldState.externalState.activatedAt || Date.now(),
						address: fieldState.externalState.address,
					});
				}
			} else if (fieldState?.status === "uncertain") {
				uncertainFields.push({
					key: control.key,
					label: control.label,
					value: fieldState.value ?? null,
					confidence: fieldState.confidence ?? 0,
				});
			} else if (fieldState?.status === "invalid") {
				missingRequired.push({
					key: control.key,
					label: control.label,
					description: control.description,
					askPrompt: control.askPrompt,
				});
				if (!nextField) nextField = control;
			} else if (control.required && fieldState?.status !== "skipped") {
				missingRequired.push({
					key: control.key,
					label: control.label,
					description: control.description,
					askPrompt: control.askPrompt,
				});
				if (!nextField) nextField = control;
			} else if (!nextField && fieldState?.status === "empty") {
				nextField = control;
			}
		}

		const progress =
			totalRequired > 0 ? Math.round((filledCount / totalRequired) * 100) : 100;

		return {
			hasActiveForm: true,
			formId: session.formId,
			formName: form.name,
			progress,
			filledFields,
			missingRequired,
			uncertainFields,
			nextField,
			status: session.status,
			pendingCancelConfirmation:
				session.cancelConfirmationAsked && session.status === "active",
			pendingExternalFields,
		};
	}

	getValues(session: FormSession): Record<string, JsonValue> {
		const values: Record<string, JsonValue> = {};
		for (const [key, state] of Object.entries(session.fields)) {
			if (state.value !== undefined) {
				values[key] = state.value;
			}
		}
		return values;
	}

	getMappedValues(session: FormSession): Record<string, JsonValue> {
		const form = this.getForm(session.formId);
		if (!form) return {};

		const values: Record<string, JsonValue> = {};
		for (const control of form.controls) {
			const state = session.fields[control.key];
			if (state?.value !== undefined) {
				const key = control.dbbind || control.key;
				values[key] = state.value;
			}
		}
		return values;
	}

	// ============================================================================
	// TTL & EFFORT
	// ============================================================================

	calculateTTL(session: FormSession): number {
		const form = this.getForm(session.formId);
		const config = form?.ttl || {};

		const minDays = config.minDays ?? 14;
		const maxDays = config.maxDays ?? 90;
		const multiplier = config.effortMultiplier ?? 0.5;

		const minutesSpent = session.effort.timeSpentMs / 60000;
		const effortDays = minutesSpent * multiplier;

		const ttlDays = Math.min(maxDays, Math.max(minDays, effortDays));
		return Date.now() + ttlDays * 24 * 60 * 60 * 1000;
	}

	shouldConfirmCancel(session: FormSession): boolean {
		const minEffortMs = 5 * 60 * 1000;
		return session.effort.timeSpentMs > minEffortMs;
	}

	// ============================================================================
	// HOOKS
	// ============================================================================

	private async executeHook(
		session: FormSession,
		hookName: keyof NonNullable<FormDefinition["hooks"]>,
		options?: Record<string, JsonValue>,
	): Promise<void> {
		const form = this.getForm(session.formId);
		const workerName = form?.hooks?.[hookName];

		if (!workerName) return;

		const worker = this.runtime.getTaskWorker(workerName);
		if (!worker) {
			logger.warn(`[FormService] Hook worker not found: ${workerName}`);
			return;
		}

		try {
			const task: Task = {
				id: session.id as UUID,
				name: workerName,
				roomId: session.roomId,
				entityId: session.entityId,
				tags: [],
			};
			await worker.execute(
				this.runtime,
				{
					session,
					form,
					...options,
				},
				task,
			);
		} catch (error) {
			logger.error(
				`[FormService] Hook execution failed: ${hookName}`,
				String(error),
			);
		}
	}

	// ============================================================================
	// HELPERS
	// ============================================================================

	private checkAllRequiredFilled(
		session: FormSession,
		form: FormDefinition,
	): boolean {
		for (const control of form.controls) {
			if (!control.required) continue;

			const fieldState = session.fields[control.key];
			if (
				!fieldState ||
				fieldState.status === "empty" ||
				fieldState.status === "invalid"
			) {
				return false;
			}
		}
		return true;
	}
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function prettify(key: string): string {
	return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
