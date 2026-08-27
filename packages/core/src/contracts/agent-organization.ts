/**
 * Defines the host-neutral, revisioned organization aggregate and its deterministic command transition.
 *
 * The aggregate owns snapshot state, idempotency receipts, and audit entries as
 * one value so a persistence adapter can commit all three atomically. Executor
 * protocols and storage mechanisms remain outside this contract.
 */

import { ElizaError } from "../errors";

declare const organizationIdBrand: unique symbol;
declare const organizationCommandIdBrand: unique symbol;
declare const organizationPrincipalIdBrand: unique symbol;
declare const organizationTimestampBrand: unique symbol;

export type OrganizationId = string & { readonly [organizationIdBrand]: true };
export type OrganizationCommandId = string & {
	readonly [organizationCommandIdBrand]: true;
};
export type OrganizationPrincipalId = string & {
	readonly [organizationPrincipalIdBrand]: true;
};
export type OrganizationTimestamp = string & {
	readonly [organizationTimestampBrand]: true;
};

export interface AgentOrganization {
	id: OrganizationId;
	name: string;
	goal: string;
	sponsorPrincipalId: OrganizationPrincipalId;
	status: "active";
	createdAt: OrganizationTimestamp;
	updatedAt: OrganizationTimestamp;
}

export type OrganizationCommand =
	| { type: "create_organization"; name: string; goal: string }
	| { type: "rename_organization"; name: string }
	| { type: "change_organization_goal"; goal: string };

export interface OrganizationCommandEnvelope {
	organizationId: OrganizationId;
	commandId: OrganizationCommandId;
	expectedRevision: number;
	actorPrincipalId: OrganizationPrincipalId;
	issuedAt: OrganizationTimestamp;
	command: OrganizationCommand;
}

export interface OrganizationCommandReceipt {
	commandId: OrganizationCommandId;
	commandFingerprint: string;
	commandEnvelope: OrganizationCommandEnvelope;
	resultingRevision: number;
	committedAt: OrganizationTimestamp;
}

export interface OrganizationAuditEntry {
	sequence: number;
	revision: number;
	commandId: OrganizationCommandId;
	actorPrincipalId: OrganizationPrincipalId;
	commandType: OrganizationCommand["type"];
	timestamp: OrganizationTimestamp;
}

export interface AgentOrganizationRecord {
	schemaVersion: 1;
	revision: number;
	organization: AgentOrganization;
	receipts: OrganizationCommandReceipt[];
	audit: OrganizationAuditEntry[];
}

export interface OrganizationCommandResult {
	record: AgentOrganizationRecord;
	replayed: boolean;
}

export interface OrganizationStore {
	get(organizationId: OrganizationId): Promise<AgentOrganizationRecord | null>;
	apply(
		envelope: OrganizationCommandEnvelope,
	): Promise<OrganizationCommandResult>;
}

function requiredText(value: unknown, field: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!normalized) {
		throw new ElizaError(`Organization ${field} is required`, {
			code: "ORGANIZATION_INVALID_COMMAND",
			context: { field },
		});
	}
	return normalized;
}

export function toOrganizationId(value: string): OrganizationId {
	return requiredText(value, "organizationId") as OrganizationId;
}

export function toOrganizationCommandId(value: string): OrganizationCommandId {
	return requiredText(value, "commandId") as OrganizationCommandId;
}

export function toOrganizationPrincipalId(
	value: string,
): OrganizationPrincipalId {
	return requiredText(value, "actorPrincipalId") as OrganizationPrincipalId;
}

export function toOrganizationTimestamp(value: string): OrganizationTimestamp {
	const timestamp = requiredText(value, "timestamp");
	if (Number.isNaN(Date.parse(timestamp))) {
		throw new ElizaError("Organization timestamp is invalid", {
			code: "ORGANIZATION_INVALID_COMMAND",
		});
	}
	return timestamp as OrganizationTimestamp;
}

function assertEnvelope(envelope: OrganizationCommandEnvelope): void {
	requiredText(envelope.organizationId, "organizationId");
	requiredText(envelope.commandId, "commandId");
	requiredText(envelope.actorPrincipalId, "actorPrincipalId");
	if (
		!Number.isSafeInteger(envelope.expectedRevision) ||
		envelope.expectedRevision < 0
	) {
		throw new ElizaError(
			"Organization expectedRevision must be a non-negative safe integer",
			{
				code: "ORGANIZATION_INVALID_COMMAND",
				context: { expectedRevision: envelope.expectedRevision },
			},
		);
	}
	if (Number.isNaN(Date.parse(envelope.issuedAt))) {
		throw new ElizaError(
			"Organization issuedAt must be an ISO-compatible timestamp",
			{
				code: "ORGANIZATION_INVALID_COMMAND",
				context: { issuedAt: envelope.issuedAt },
			},
		);
	}
	if (envelope.command.type === "create_organization") {
		requiredText(envelope.command.name, "name");
		requiredText(envelope.command.goal, "goal");
	} else if (envelope.command.type === "rename_organization") {
		requiredText(envelope.command.name, "name");
	} else if (envelope.command.type === "change_organization_goal") {
		requiredText(envelope.command.goal, "goal");
	} else {
		throw new ElizaError("Organization command type is unsupported", {
			code: "ORGANIZATION_INVALID_COMMAND",
		});
	}
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",")}}`;
}

function commandFingerprint(envelope: OrganizationCommandEnvelope): string {
	return canonicalize(normalizedEnvelope(envelope));
}

function normalizedEnvelope(
	envelope: OrganizationCommandEnvelope,
): OrganizationCommandEnvelope {
	let command: OrganizationCommand;
	switch (envelope.command.type) {
		case "create_organization":
			command = {
				type: envelope.command.type,
				name: requiredText(envelope.command.name, "name"),
				goal: requiredText(envelope.command.goal, "goal"),
			};
			break;
		case "rename_organization":
			command = {
				type: envelope.command.type,
				name: requiredText(envelope.command.name, "name"),
			};
			break;
		case "change_organization_goal":
			command = {
				type: envelope.command.type,
				goal: requiredText(envelope.command.goal, "goal"),
			};
			break;
		default:
			assertNever(envelope.command);
	}
	return {
		organizationId: toOrganizationId(envelope.organizationId),
		commandId: toOrganizationCommandId(envelope.commandId),
		expectedRevision: envelope.expectedRevision,
		actorPrincipalId: toOrganizationPrincipalId(envelope.actorPrincipalId),
		issuedAt: toOrganizationTimestamp(envelope.issuedAt),
		command,
	};
}

function replayOrCollision(
	record: AgentOrganizationRecord,
	envelope: OrganizationCommandEnvelope,
): OrganizationCommandResult | null {
	const receipt = record.receipts.find(
		(candidate) => candidate.commandId === envelope.commandId,
	);
	if (!receipt) return null;
	if (receipt.commandFingerprint !== commandFingerprint(envelope)) {
		throw new ElizaError(
			"Organization command id was reused with different content",
			{
				code: "ORGANIZATION_COMMAND_ID_COLLISION",
				context: {
					organizationId: envelope.organizationId,
					commandId: envelope.commandId,
				},
				severity: "fatal",
			},
		);
	}
	return { record: structuredClone(record), replayed: true };
}

function commit(
	record: AgentOrganizationRecord,
	envelope: OrganizationCommandEnvelope,
	organization: AgentOrganization,
): OrganizationCommandResult {
	const revision = record.revision + 1;
	const commandEnvelope = normalizedEnvelope(envelope);
	const next: AgentOrganizationRecord = {
		...structuredClone(record),
		revision,
		organization,
		receipts: [
			...record.receipts,
			{
				commandId: envelope.commandId,
				commandFingerprint: commandFingerprint(envelope),
				commandEnvelope,
				resultingRevision: revision,
				committedAt: envelope.issuedAt,
			},
		],
		audit: [
			...record.audit,
			{
				sequence: record.audit.length + 1,
				revision,
				commandId: envelope.commandId,
				actorPrincipalId: envelope.actorPrincipalId,
				commandType: envelope.command.type,
				timestamp: envelope.issuedAt,
			},
		],
	};
	return { record: next, replayed: false };
}

export function createOrganizationRecord(
	envelope: OrganizationCommandEnvelope & {
		command: Extract<OrganizationCommand, { type: "create_organization" }>;
	},
): OrganizationCommandResult {
	assertEnvelope(envelope);
	if (envelope.expectedRevision !== 0) {
		throw new ElizaError(
			"A new organization must start at expected revision zero",
			{
				code: "ORGANIZATION_REVISION_CONFLICT",
				context: {
					expectedRevision: envelope.expectedRevision,
					actualRevision: 0,
				},
			},
		);
	}
	const name = requiredText(envelope.command.name, "name");
	const goal = requiredText(envelope.command.goal, "goal");
	const empty: AgentOrganizationRecord = {
		schemaVersion: 1,
		revision: 0,
		organization: {
			id: envelope.organizationId,
			name,
			goal,
			sponsorPrincipalId: envelope.actorPrincipalId,
			status: "active",
			createdAt: envelope.issuedAt,
			updatedAt: envelope.issuedAt,
		},
		receipts: [],
		audit: [],
	};
	return commit(empty, envelope, empty.organization);
}

export async function applyOrganizationCommand(
	record: AgentOrganizationRecord,
	envelope: OrganizationCommandEnvelope,
	authorize: OrganizationCommandAuthorizer,
): Promise<OrganizationCommandResult> {
	assertEnvelope(envelope);
	if (record.organization.id !== envelope.organizationId) {
		throw new ElizaError("Organization command targets a different aggregate", {
			code: "ORGANIZATION_ID_MISMATCH",
			context: {
				expected: record.organization.id,
				received: envelope.organizationId,
			},
		});
	}
	if (!(await authorize(record, envelope))) {
		throw new ElizaError("Organization mutation was denied", {
			code: "ORGANIZATION_MUTATION_DENIED",
			context: {
				organizationId: envelope.organizationId,
				actorPrincipalId: envelope.actorPrincipalId,
			},
		});
	}
	const replay = replayOrCollision(record, envelope);
	if (replay) return replay;
	if (record.revision !== envelope.expectedRevision) {
		throw new ElizaError("Organization revision is stale", {
			code: "ORGANIZATION_REVISION_CONFLICT",
			context: {
				expectedRevision: envelope.expectedRevision,
				actualRevision: record.revision,
			},
		});
	}
	if (envelope.command.type === "create_organization") {
		throw new ElizaError("Organization already exists", {
			code: "ORGANIZATION_ALREADY_EXISTS",
			context: { organizationId: envelope.organizationId },
		});
	}
	const organization = structuredClone(record.organization);
	switch (envelope.command.type) {
		case "rename_organization":
			organization.name = requiredText(envelope.command.name, "name");
			break;
		case "change_organization_goal":
			organization.goal = requiredText(envelope.command.goal, "goal");
			break;
		default:
			assertNever(envelope.command);
	}
	organization.updatedAt = envelope.issuedAt;
	return commit(record, envelope, organization);
}

export type OrganizationCommandAuthorizer = (
	record: AgentOrganizationRecord | null,
	envelope: OrganizationCommandEnvelope,
) => boolean | Promise<boolean>;

/** Fail-closed Experiment 1 policy; production services must inject core trust authorization. */
export const sponsorOnlyOrganizationAuthorizer: OrganizationCommandAuthorizer =
	(record, envelope) =>
		record === null ||
		record.organization.sponsorPrincipalId === envelope.actorPrincipalId;

export async function transitionOrganizationRecord(
	record: AgentOrganizationRecord | null,
	envelope: OrganizationCommandEnvelope,
	authorize: OrganizationCommandAuthorizer,
): Promise<OrganizationCommandResult> {
	if (record) return applyOrganizationCommand(record, envelope, authorize);
	if (envelope.command.type === "create_organization") {
		if (!(await authorize(null, envelope))) {
			throw new ElizaError("Organization creation was denied", {
				code: "ORGANIZATION_MUTATION_DENIED",
				context: {
					organizationId: envelope.organizationId,
					actorPrincipalId: envelope.actorPrincipalId,
				},
			});
		}
		return createOrganizationRecord({ ...envelope, command: envelope.command });
	}
	throw new ElizaError("Organization does not exist", {
		code: "ORGANIZATION_NOT_FOUND",
		context: { organizationId: envelope.organizationId },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOrganizationCommandType(
	value: unknown,
): value is OrganizationCommand["type"] {
	return (
		value === "create_organization" ||
		value === "rename_organization" ||
		value === "change_organization_goal"
	);
}

function persistedTimestamp(
	value: unknown,
	field: string,
): OrganizationTimestamp {
	const timestamp = persistedText(value, field);
	if (Number.isNaN(Date.parse(timestamp))) {
		throw new ElizaError(`Persisted organization ${field} is invalid`, {
			code: "ORGANIZATION_STORE_CORRUPT",
			context: { field },
			severity: "fatal",
		});
	}
	return timestamp as OrganizationTimestamp;
}

function persistedText(value: unknown, field: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!normalized) {
		throw new ElizaError(`Persisted organization ${field} is invalid`, {
			code: "ORGANIZATION_STORE_CORRUPT",
			context: { field },
			severity: "fatal",
		});
	}
	return normalized;
}

function assertNever(value: never): never {
	throw new ElizaError("Organization command type is unsupported", {
		code: "ORGANIZATION_INVALID_COMMAND",
		context: { value },
	});
}

function persistedCommandEnvelope(value: unknown): OrganizationCommandEnvelope {
	if (!isRecord(value) || !isRecord(value.command)) {
		throw new ElizaError("Persisted organization command envelope is invalid", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	const expectedRevision = value.expectedRevision;
	if (
		!Number.isSafeInteger(expectedRevision) ||
		(expectedRevision as number) < 0
	) {
		throw new ElizaError("Persisted organization command revision is invalid", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	const type = value.command.type;
	let command: OrganizationCommand;
	switch (type) {
		case "create_organization":
			command = {
				type,
				name: persistedText(value.command.name, "command.name"),
				goal: persistedText(value.command.goal, "command.goal"),
			};
			break;
		case "rename_organization":
			command = {
				type,
				name: persistedText(value.command.name, "command.name"),
			};
			break;
		case "change_organization_goal":
			command = {
				type,
				goal: persistedText(value.command.goal, "command.goal"),
			};
			break;
		default:
			throw new ElizaError("Persisted organization command type is invalid", {
				code: "ORGANIZATION_STORE_CORRUPT",
				severity: "fatal",
			});
	}
	return {
		organizationId: persistedText(
			value.organizationId,
			"command.organizationId",
		) as OrganizationId,
		commandId: persistedText(
			value.commandId,
			"command.commandId",
		) as OrganizationCommandId,
		expectedRevision: expectedRevision as number,
		actorPrincipalId: persistedText(
			value.actorPrincipalId,
			"command.actorPrincipalId",
		) as OrganizationPrincipalId,
		issuedAt: persistedTimestamp(value.issuedAt, "command.issuedAt"),
		command,
	};
}

function reconstructOrganization(
	receipts: OrganizationCommandReceipt[],
): AgentOrganization {
	const first = receipts[0]?.commandEnvelope;
	if (first?.command.type !== "create_organization") {
		throw new ElizaError(
			"Persisted organization history must begin with creation",
			{
				code: "ORGANIZATION_STORE_CORRUPT",
				severity: "fatal",
			},
		);
	}
	const organization: AgentOrganization = {
		id: first.organizationId,
		name: first.command.name,
		goal: first.command.goal,
		sponsorPrincipalId: first.actorPrincipalId,
		status: "active",
		createdAt: first.issuedAt,
		updatedAt: first.issuedAt,
	};
	for (const receipt of receipts.slice(1)) {
		const envelope = receipt.commandEnvelope;
		switch (envelope.command.type) {
			case "rename_organization":
				organization.name = envelope.command.name;
				break;
			case "change_organization_goal":
				organization.goal = envelope.command.goal;
				break;
			case "create_organization":
				throw new ElizaError(
					"Persisted organization history repeats creation",
					{
						code: "ORGANIZATION_STORE_CORRUPT",
						severity: "fatal",
					},
				);
			default:
				assertNever(envelope.command);
		}
		organization.updatedAt = envelope.issuedAt;
	}
	return organization;
}

/** Validates a complete persisted aggregate before it becomes trusted domain state. */
export function parseAgentOrganizationRecord(
	value: unknown,
): AgentOrganizationRecord {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!isRecord(value.organization)
	) {
		throw new ElizaError("Persisted organization record has an invalid shape", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	const revision = value.revision;
	const organization = value.organization;
	if (
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 1 ||
		!Array.isArray(value.receipts) ||
		!Array.isArray(value.audit) ||
		value.receipts.length !== revision ||
		value.audit.length !== revision
	) {
		throw new ElizaError(
			"Persisted organization revision history is inconsistent",
			{
				code: "ORGANIZATION_STORE_CORRUPT",
				severity: "fatal",
			},
		);
	}
	const status = organization.status;
	if (status !== "active") {
		throw new ElizaError("Persisted organization status is invalid", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	const seenCommandIds = new Set<string>();
	const receipts = value.receipts.map(
		(item, index): OrganizationCommandReceipt => {
			if (
				!isRecord(item) ||
				item.resultingRevision !== index + 1 ||
				typeof item.commandFingerprint !== "string"
			) {
				throw new ElizaError("Persisted organization receipt is invalid", {
					code: "ORGANIZATION_STORE_CORRUPT",
					context: { index },
					severity: "fatal",
				});
			}
			const commandId = persistedText(item.commandId, "commandId");
			const commandEnvelope = persistedCommandEnvelope(item.commandEnvelope);
			if (
				commandEnvelope.commandId !== commandId ||
				commandEnvelope.expectedRevision !== index ||
				commandFingerprint(commandEnvelope) !== item.commandFingerprint
			) {
				throw new ElizaError(
					"Persisted organization receipt proof is invalid",
					{
						code: "ORGANIZATION_STORE_CORRUPT",
						context: { index },
						severity: "fatal",
					},
				);
			}
			if (seenCommandIds.has(commandId)) {
				throw new ElizaError(
					"Persisted organization command id is duplicated",
					{
						code: "ORGANIZATION_STORE_CORRUPT",
						context: { index, commandId },
						severity: "fatal",
					},
				);
			}
			seenCommandIds.add(commandId);
			const committedAt = persistedTimestamp(item.committedAt, "committedAt");
			if (committedAt !== commandEnvelope.issuedAt) {
				throw new ElizaError(
					"Persisted organization receipt time is inconsistent",
					{
						code: "ORGANIZATION_STORE_CORRUPT",
						context: { index },
						severity: "fatal",
					},
				);
			}
			return {
				commandId: commandId as OrganizationCommandId,
				commandFingerprint: persistedText(
					item.commandFingerprint,
					"commandFingerprint",
				),
				commandEnvelope,
				resultingRevision: index + 1,
				committedAt,
			};
		},
	);
	const audit = value.audit.map((item, index): OrganizationAuditEntry => {
		if (
			!isRecord(item) ||
			item.sequence !== index + 1 ||
			item.revision !== index + 1 ||
			!receipts[index] ||
			item.commandId !== receipts[index].commandId ||
			!isOrganizationCommandType(item.commandType) ||
			item.commandType !== receipts[index].commandEnvelope.command.type ||
			item.actorPrincipalId !==
				receipts[index].commandEnvelope.actorPrincipalId ||
			item.timestamp !== receipts[index].commandEnvelope.issuedAt
		) {
			throw new ElizaError("Persisted organization audit entry is invalid", {
				code: "ORGANIZATION_STORE_CORRUPT",
				context: { index },
				severity: "fatal",
			});
		}
		return {
			sequence: index + 1,
			revision: index + 1,
			commandId: receipts[index].commandId,
			actorPrincipalId: persistedText(
				item.actorPrincipalId,
				"actorPrincipalId",
			) as OrganizationPrincipalId,
			commandType: item.commandType,
			timestamp: persistedTimestamp(item.timestamp, "timestamp"),
		};
	});
	const organizationId = persistedText(
		organization.id,
		"organizationId",
	) as OrganizationId;
	if (
		receipts.some(
			(receipt) => receipt.commandEnvelope.organizationId !== organizationId,
		)
	) {
		throw new ElizaError("Persisted receipt targets a different organization", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	const parsedOrganization: AgentOrganization = {
		id: organizationId,
		name: persistedText(organization.name, "name"),
		goal: persistedText(organization.goal, "goal"),
		sponsorPrincipalId: persistedText(
			organization.sponsorPrincipalId,
			"sponsorPrincipalId",
		) as OrganizationPrincipalId,
		status,
		createdAt: persistedTimestamp(organization.createdAt, "createdAt"),
		updatedAt: persistedTimestamp(organization.updatedAt, "updatedAt"),
	};
	if (
		canonicalize(parsedOrganization) !==
		canonicalize(reconstructOrganization(receipts))
	) {
		throw new ElizaError(
			"Persisted organization snapshot does not match history",
			{
				code: "ORGANIZATION_STORE_CORRUPT",
				severity: "fatal",
			},
		);
	}
	return {
		schemaVersion: 1,
		revision,
		organization: parsedOrganization,
		receipts,
		audit,
	};
}

/** Deterministic single-host store for tests and ephemeral runtimes. */
export class InMemoryOrganizationStore implements OrganizationStore {
	constructor(
		private readonly authorize: OrganizationCommandAuthorizer = sponsorOnlyOrganizationAuthorizer,
	) {}
	private readonly records = new Map<string, AgentOrganizationRecord>();
	private tail: Promise<void> = Promise.resolve();

	async get(
		organizationId: OrganizationId,
	): Promise<AgentOrganizationRecord | null> {
		await this.tail;
		const record = this.records.get(organizationId);
		return record ? structuredClone(record) : null;
	}

	apply(
		envelope: OrganizationCommandEnvelope,
	): Promise<OrganizationCommandResult> {
		const operation = this.tail.then(async () => {
			const current = this.records.get(envelope.organizationId) ?? null;
			const result = await transitionOrganizationRecord(
				current,
				envelope,
				this.authorize,
			);
			if (!result.replayed)
				this.records.set(envelope.organizationId, result.record);
			return {
				record: structuredClone(result.record),
				replayed: result.replayed,
			};
		});
		this.tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}
