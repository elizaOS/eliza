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
	status: "active" | "completed";
	members: OrganizationMember[];
	workItems: OrganizationWorkItem[];
	createdAt: OrganizationTimestamp;
	updatedAt: OrganizationTimestamp;
}

export type OrganizationMemberAuthority = "coordinate" | "contribute";

export interface OrganizationMember {
	id: string;
	principalId: OrganizationPrincipalId;
	name: string;
	role: string;
	capabilities: string[];
	authority: OrganizationMemberAuthority;
}

export type OrganizationWorkStatus =
	| "assigned"
	| "in_progress"
	| "completed"
	| "failed";

export interface OrganizationWorkItem {
	id: string;
	objective: string;
	assigneeMemberId: string;
	dependsOnWorkItemIds: string[];
	status: OrganizationWorkStatus;
	executionId?: string;
	result?: string;
}

export type OrganizationCommand =
	| { type: "create_organization"; name: string; goal: string }
	| { type: "rename_organization"; name: string }
	| { type: "change_organization_goal"; goal: string }
	| { type: "add_member"; member: OrganizationMember }
	| {
			type: "adopt_plan";
			members: OrganizationMember[];
			workItems: Array<
				Pick<
					OrganizationWorkItem,
					"id" | "objective" | "assigneeMemberId" | "dependsOnWorkItemIds"
				>
			>;
	  }
	| {
			type: "assign_work";
			workItem: Pick<
				OrganizationWorkItem,
				"id" | "objective" | "assigneeMemberId" | "dependsOnWorkItemIds"
			>;
	  }
	| { type: "bind_work_execution"; workItemId: string; executionId: string }
	| {
			type: "update_work_status";
			workItemId: string;
			status: Exclude<OrganizationWorkStatus, "assigned">;
			result?: string;
	  }
	| {
			type: "reassign_work";
			workItemId: string;
			assigneeMemberId: string;
			reason: string;
	  }
	| { type: "complete_organization" };

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
	list(): Promise<AgentOrganizationRecord[]>;
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

function requiredTextList(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) {
		throw new ElizaError(`Organization ${field} must be an array`, {
			code: "ORGANIZATION_INVALID_COMMAND",
			context: { field },
		});
	}
	return value.map((item, index) => requiredText(item, `${field}.${index}`));
}

function normalizeMember(member: OrganizationMember): OrganizationMember {
	if (member.authority !== "coordinate" && member.authority !== "contribute") {
		throw new ElizaError("Organization member authority is invalid", {
			code: "ORGANIZATION_INVALID_COMMAND",
		});
	}
	return {
		id: requiredText(member.id, "member.id"),
		principalId: toOrganizationPrincipalId(member.principalId),
		name: requiredText(member.name, "member.name"),
		role: requiredText(member.role, "member.role"),
		capabilities: requiredTextList(member.capabilities, "member.capabilities"),
		authority: member.authority,
	};
}

function normalizeWorkItem(
	workItem: Extract<OrganizationCommand, { type: "assign_work" }>["workItem"],
): Extract<OrganizationCommand, { type: "assign_work" }>["workItem"] {
	return {
		id: requiredText(workItem.id, "workItem.id"),
		objective: requiredText(workItem.objective, "workItem.objective"),
		assigneeMemberId: requiredText(
			workItem.assigneeMemberId,
			"workItem.assigneeMemberId",
		),
		dependsOnWorkItemIds: requiredTextList(
			workItem.dependsOnWorkItemIds,
			"workItem.dependsOnWorkItemIds",
		),
	};
}

function hasWorkDependencyCycle(
	workItems: ReadonlyArray<
		Pick<OrganizationWorkItem, "id" | "dependsOnWorkItemIds">
	>,
): boolean {
	const dependencies = new Map(
		workItems.map((item) => [item.id, item.dependsOnWorkItemIds]),
	);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): boolean => {
		if (visiting.has(id)) return true;
		if (visited.has(id)) return false;
		visiting.add(id);
		for (const dependency of dependencies.get(id) ?? []) {
			if (visit(dependency)) return true;
		}
		visiting.delete(id);
		visited.add(id);
		return false;
	};
	return workItems.some((item) => visit(item.id));
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
	} else if (envelope.command.type === "add_member") {
		normalizeMember(envelope.command.member);
	} else if (envelope.command.type === "adopt_plan") {
		envelope.command.members.map(normalizeMember);
		envelope.command.workItems.map(normalizeWorkItem);
	} else if (envelope.command.type === "assign_work") {
		normalizeWorkItem(envelope.command.workItem);
	} else if (envelope.command.type === "bind_work_execution") {
		requiredText(envelope.command.workItemId, "workItemId");
		requiredText(envelope.command.executionId, "executionId");
	} else if (envelope.command.type === "update_work_status") {
		requiredText(envelope.command.workItemId, "workItemId");
		if (
			!["in_progress", "completed", "failed"].includes(envelope.command.status)
		) {
			throw new ElizaError("Organization work status is invalid", {
				code: "ORGANIZATION_INVALID_COMMAND",
			});
		}
		if (envelope.command.result !== undefined) {
			requiredText(envelope.command.result, "result");
		}
	} else if (envelope.command.type === "reassign_work") {
		requiredText(envelope.command.workItemId, "workItemId");
		requiredText(envelope.command.assigneeMemberId, "assigneeMemberId");
		requiredText(envelope.command.reason, "reason");
	} else if (envelope.command.type === "complete_organization") {
		return;
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
		case "add_member":
			command = {
				type: envelope.command.type,
				member: normalizeMember(envelope.command.member),
			};
			break;
		case "adopt_plan":
			command = {
				type: envelope.command.type,
				members: envelope.command.members.map(normalizeMember),
				workItems: envelope.command.workItems.map(normalizeWorkItem),
			};
			break;
		case "assign_work":
			command = {
				type: envelope.command.type,
				workItem: normalizeWorkItem(envelope.command.workItem),
			};
			break;
		case "bind_work_execution":
			command = {
				type: envelope.command.type,
				workItemId: requiredText(envelope.command.workItemId, "workItemId"),
				executionId: requiredText(envelope.command.executionId, "executionId"),
			};
			break;
		case "update_work_status":
			command = {
				type: envelope.command.type,
				workItemId: requiredText(envelope.command.workItemId, "workItemId"),
				status: envelope.command.status,
				...(envelope.command.result === undefined
					? {}
					: { result: requiredText(envelope.command.result, "result") }),
			};
			break;
		case "reassign_work":
			command = {
				type: envelope.command.type,
				workItemId: requiredText(envelope.command.workItemId, "workItemId"),
				assigneeMemberId: requiredText(
					envelope.command.assigneeMemberId,
					"assigneeMemberId",
				),
				reason: requiredText(envelope.command.reason, "reason"),
			};
			break;
		case "complete_organization":
			command = { type: envelope.command.type };
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
			members: [],
			workItems: [],
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
	if (organization.status === "completed") {
		throw new ElizaError("Completed organizations cannot be mutated", {
			code: "ORGANIZATION_ALREADY_COMPLETED",
			context: { organizationId: organization.id },
		});
	}
	switch (envelope.command.type) {
		case "rename_organization":
			organization.name = requiredText(envelope.command.name, "name");
			break;
		case "change_organization_goal":
			organization.goal = requiredText(envelope.command.goal, "goal");
			break;
		case "add_member": {
			const member = normalizeMember(envelope.command.member);
			if (
				organization.members.some(
					(candidate) =>
						candidate.id === member.id ||
						candidate.principalId === member.principalId,
				)
			) {
				throw new ElizaError("Organization member already exists", {
					code: "ORGANIZATION_MEMBER_CONFLICT",
					context: { memberId: member.id },
				});
			}
			organization.members.push(member);
			break;
		}
		case "adopt_plan": {
			if (
				organization.members.length > 0 ||
				organization.workItems.length > 0
			) {
				throw new ElizaError("Organization plan already exists", {
					code: "ORGANIZATION_PLAN_CONFLICT",
				});
			}
			const members = envelope.command.members.map(normalizeMember);
			const memberIds = new Set(members.map((member) => member.id));
			const principals = new Set(members.map((member) => member.principalId));
			if (
				memberIds.size !== members.length ||
				principals.size !== members.length
			) {
				throw new ElizaError("Organization plan contains duplicate members", {
					code: "ORGANIZATION_MEMBER_CONFLICT",
				});
			}
			const workItems = envelope.command.workItems.map(normalizeWorkItem);
			const workIds = new Set(workItems.map((item) => item.id));
			if (workIds.size !== workItems.length) {
				throw new ElizaError("Organization plan contains duplicate work", {
					code: "ORGANIZATION_WORK_CONFLICT",
				});
			}
			for (const item of workItems) {
				if (!memberIds.has(item.assigneeMemberId)) {
					throw new ElizaError("Organization plan assignee does not exist", {
						code: "ORGANIZATION_MEMBER_NOT_FOUND",
					});
				}
				if (
					item.dependsOnWorkItemIds.some(
						(id) => !workIds.has(id) || id === item.id,
					)
				) {
					throw new ElizaError("Organization plan dependency is invalid", {
						code: "ORGANIZATION_WORK_DEPENDENCY_NOT_FOUND",
					});
				}
			}
			if (hasWorkDependencyCycle(workItems)) {
				throw new ElizaError("Organization plan contains a dependency cycle", {
					code: "ORGANIZATION_WORK_DEPENDENCY_CYCLE",
				});
			}
			organization.members = members;
			organization.workItems = workItems.map((item) => ({
				...item,
				status: "assigned",
			}));
			break;
		}
		case "assign_work": {
			const workItem = normalizeWorkItem(envelope.command.workItem);
			if (
				organization.workItems.some((candidate) => candidate.id === workItem.id)
			) {
				throw new ElizaError("Organization work item already exists", {
					code: "ORGANIZATION_WORK_CONFLICT",
					context: { workItemId: workItem.id },
				});
			}
			if (
				!organization.members.some(
					(member) => member.id === workItem.assigneeMemberId,
				)
			) {
				throw new ElizaError("Organization work assignee does not exist", {
					code: "ORGANIZATION_MEMBER_NOT_FOUND",
					context: { memberId: workItem.assigneeMemberId },
				});
			}
			const knownWorkIds = new Set(
				organization.workItems.map((item) => item.id),
			);
			if (workItem.dependsOnWorkItemIds.some((id) => !knownWorkIds.has(id))) {
				throw new ElizaError("Organization work dependency does not exist", {
					code: "ORGANIZATION_WORK_DEPENDENCY_NOT_FOUND",
					context: { workItemId: workItem.id },
				});
			}
			organization.workItems.push({ ...workItem, status: "assigned" });
			break;
		}
		case "bind_work_execution": {
			const command = envelope.command;
			const workItem = organization.workItems.find(
				(candidate) => candidate.id === command.workItemId,
			);
			if (!workItem) {
				throw new ElizaError("Organization work item does not exist", {
					code: "ORGANIZATION_WORK_NOT_FOUND",
				});
			}
			const executionId = requiredText(command.executionId, "executionId");
			if (workItem.status !== "assigned") {
				throw new ElizaError(
					"Organization work execution can only bind while assigned",
					{
						code: "ORGANIZATION_WORK_TRANSITION_INVALID",
						context: { workItemId: workItem.id, status: workItem.status },
					},
				);
			}
			if (workItem.executionId && workItem.executionId !== executionId) {
				throw new ElizaError(
					"Organization work already has another execution",
					{
						code: "ORGANIZATION_EXECUTION_CONFLICT",
						context: { workItemId: workItem.id },
					},
				);
			}
			workItem.executionId = executionId;
			break;
		}
		case "update_work_status": {
			const command = envelope.command;
			const workItem = organization.workItems.find(
				(candidate) => candidate.id === command.workItemId,
			);
			if (!workItem) {
				throw new ElizaError("Organization work item does not exist", {
					code: "ORGANIZATION_WORK_NOT_FOUND",
				});
			}
			const validTransition =
				(workItem.status === "assigned" && command.status === "in_progress") ||
				(workItem.status === "in_progress" &&
					(command.status === "completed" || command.status === "failed"));
			if (!validTransition) {
				throw new ElizaError("Organization work status transition is invalid", {
					code: "ORGANIZATION_WORK_TRANSITION_INVALID",
					context: {
						workItemId: workItem.id,
						from: workItem.status,
						to: command.status,
					},
				});
			}
			if (!workItem.executionId) {
				throw new ElizaError(
					"Organization work cannot advance without an execution",
					{
						code: "ORGANIZATION_EXECUTION_REQUIRED",
						context: { workItemId: workItem.id },
					},
				);
			}
			workItem.status = command.status;
			if (command.result !== undefined) {
				workItem.result = requiredText(command.result, "result");
			}
			break;
		}
		case "reassign_work": {
			const command = envelope.command;
			const workItem = organization.workItems.find(
				(candidate) => candidate.id === command.workItemId,
			);
			if (!workItem) {
				throw new ElizaError("Organization work item does not exist", {
					code: "ORGANIZATION_WORK_NOT_FOUND",
				});
			}
			if (workItem.status !== "failed") {
				throw new ElizaError(
					"Only failed organization work can be reassigned",
					{
						code: "ORGANIZATION_WORK_TRANSITION_INVALID",
						context: { workItemId: workItem.id, status: workItem.status },
					},
				);
			}
			if (
				!organization.members.some(
					(member) => member.id === command.assigneeMemberId,
				)
			) {
				throw new ElizaError("Organization work assignee does not exist", {
					code: "ORGANIZATION_MEMBER_NOT_FOUND",
				});
			}
			workItem.assigneeMemberId = command.assigneeMemberId;
			workItem.status = "assigned";
			delete workItem.executionId;
			delete workItem.result;
			break;
		}
		case "complete_organization":
			if (
				organization.workItems.length === 0 ||
				organization.workItems.some((item) => item.status !== "completed")
			) {
				throw new ElizaError("Organization still has unfinished work", {
					code: "ORGANIZATION_WORK_INCOMPLETE",
				});
			}
			organization.status = "completed";
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

/** Allows sponsors to govern the organization, coordinators to manage work, and contributors to report only their own work. */
export const delegatedOrganizationAuthorizer: OrganizationCommandAuthorizer = (
	record,
	envelope,
) => {
	if (!record) return envelope.command.type === "create_organization";
	if (record.organization.sponsorPrincipalId === envelope.actorPrincipalId) {
		return true;
	}
	const member = record.organization.members.find(
		(candidate) => candidate.principalId === envelope.actorPrincipalId,
	);
	if (!member) return false;
	if (member.authority === "coordinate") {
		return [
			"add_member",
			"adopt_plan",
			"assign_work",
			"bind_work_execution",
			"update_work_status",
			"reassign_work",
			"complete_organization",
		].includes(envelope.command.type);
	}
	if (envelope.command.type !== "update_work_status") return false;
	const command = envelope.command;
	return record.organization.workItems.some(
		(item) =>
			item.id === command.workItemId && item.assigneeMemberId === member.id,
	);
};

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
		value === "change_organization_goal" ||
		value === "add_member" ||
		value === "adopt_plan" ||
		value === "assign_work" ||
		value === "bind_work_execution" ||
		value === "update_work_status" ||
		value === "reassign_work" ||
		value === "complete_organization"
	);
}

function persistedTextList(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) {
		throw new ElizaError(`Persisted organization ${field} is invalid`, {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	return value.map((item, index) => persistedText(item, `${field}.${index}`));
}

function persistedMember(value: unknown): OrganizationMember {
	if (!isRecord(value)) {
		throw new ElizaError("Persisted organization member is invalid", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	if (value.authority !== "coordinate" && value.authority !== "contribute") {
		throw new ElizaError("Persisted organization member authority is invalid", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	return {
		id: persistedText(value.id, "member.id"),
		principalId: persistedText(
			value.principalId,
			"member.principalId",
		) as OrganizationPrincipalId,
		name: persistedText(value.name, "member.name"),
		role: persistedText(value.role, "member.role"),
		capabilities: persistedTextList(value.capabilities, "member.capabilities"),
		authority: value.authority,
	};
}

function persistedWorkItem(value: unknown): OrganizationWorkItem {
	if (!isRecord(value)) {
		throw new ElizaError("Persisted organization work item is invalid", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	if (
		!["assigned", "in_progress", "completed", "failed"].includes(
			String(value.status),
		)
	) {
		throw new ElizaError("Persisted organization work status is invalid", {
			code: "ORGANIZATION_STORE_CORRUPT",
			severity: "fatal",
		});
	}
	const status = value.status as OrganizationWorkStatus;
	return {
		id: persistedText(value.id, "workItem.id"),
		objective: persistedText(value.objective, "workItem.objective"),
		assigneeMemberId: persistedText(
			value.assigneeMemberId,
			"workItem.assigneeMemberId",
		),
		dependsOnWorkItemIds: persistedTextList(
			value.dependsOnWorkItemIds,
			"workItem.dependsOnWorkItemIds",
		),
		status,
		...(value.executionId === undefined
			? {}
			: {
					executionId: persistedText(value.executionId, "workItem.executionId"),
				}),
		...(value.result === undefined
			? {}
			: { result: persistedText(value.result, "workItem.result") }),
	};
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
		case "add_member":
			command = { type, member: persistedMember(value.command.member) };
			break;
		case "adopt_plan": {
			if (
				!Array.isArray(value.command.members) ||
				!Array.isArray(value.command.workItems)
			) {
				throw new ElizaError("Persisted organization plan command is invalid", {
					code: "ORGANIZATION_STORE_CORRUPT",
					severity: "fatal",
				});
			}
			command = {
				type,
				members: value.command.members.map(persistedMember),
				workItems: value.command.workItems.map((item) => {
					const parsed = persistedWorkItem({
						...(isRecord(item) ? item : {}),
						status: "assigned",
					});
					return {
						id: parsed.id,
						objective: parsed.objective,
						assigneeMemberId: parsed.assigneeMemberId,
						dependsOnWorkItemIds: parsed.dependsOnWorkItemIds,
					};
				}),
			};
			break;
		}
		case "assign_work": {
			const workItem = value.command.workItem;
			if (!isRecord(workItem))
				throw new ElizaError("Persisted organization work command is invalid", {
					code: "ORGANIZATION_STORE_CORRUPT",
					severity: "fatal",
				});
			command = {
				type,
				workItem: {
					id: persistedText(workItem.id, "command.workItem.id"),
					objective: persistedText(
						workItem.objective,
						"command.workItem.objective",
					),
					assigneeMemberId: persistedText(
						workItem.assigneeMemberId,
						"command.workItem.assigneeMemberId",
					),
					dependsOnWorkItemIds: persistedTextList(
						workItem.dependsOnWorkItemIds,
						"command.workItem.dependsOnWorkItemIds",
					),
				},
			};
			break;
		}
		case "bind_work_execution":
			command = {
				type,
				workItemId: persistedText(
					value.command.workItemId,
					"command.workItemId",
				),
				executionId: persistedText(
					value.command.executionId,
					"command.executionId",
				),
			};
			break;
		case "update_work_status": {
			const status = value.command.status;
			if (
				status !== "in_progress" &&
				status !== "completed" &&
				status !== "failed"
			)
				throw new ElizaError(
					"Persisted organization work status command is invalid",
					{ code: "ORGANIZATION_STORE_CORRUPT", severity: "fatal" },
				);
			command = {
				type,
				workItemId: persistedText(
					value.command.workItemId,
					"command.workItemId",
				),
				status,
				...(value.command.result === undefined
					? {}
					: { result: persistedText(value.command.result, "command.result") }),
			};
			break;
		}
		case "reassign_work":
			command = {
				type,
				workItemId: persistedText(
					value.command.workItemId,
					"command.workItemId",
				),
				assigneeMemberId: persistedText(
					value.command.assigneeMemberId,
					"command.assigneeMemberId",
				),
				reason: persistedText(value.command.reason, "command.reason"),
			};
			break;
		case "complete_organization":
			command = { type };
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
		members: [],
		workItems: [],
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
			case "add_member":
				organization.members.push(structuredClone(envelope.command.member));
				break;
			case "adopt_plan":
				organization.members = structuredClone(envelope.command.members);
				organization.workItems = envelope.command.workItems.map((item) => ({
					...structuredClone(item),
					status: "assigned",
				}));
				break;
			case "assign_work":
				organization.workItems.push({
					...structuredClone(envelope.command.workItem),
					status: "assigned",
				});
				break;
			case "bind_work_execution": {
				const command = envelope.command;
				const workItem = organization.workItems.find(
					(candidate) => candidate.id === command.workItemId,
				);
				if (!workItem)
					throw new ElizaError(
						"Persisted organization execution targets missing work",
						{ code: "ORGANIZATION_STORE_CORRUPT", severity: "fatal" },
					);
				workItem.executionId = command.executionId;
				break;
			}
			case "update_work_status": {
				const command = envelope.command;
				const workItem = organization.workItems.find(
					(candidate) => candidate.id === command.workItemId,
				);
				if (!workItem)
					throw new ElizaError(
						"Persisted organization status targets missing work",
						{ code: "ORGANIZATION_STORE_CORRUPT", severity: "fatal" },
					);
				workItem.status = command.status;
				if (command.result !== undefined) workItem.result = command.result;
				break;
			}
			case "reassign_work": {
				const command = envelope.command;
				const workItem = organization.workItems.find(
					(candidate) => candidate.id === command.workItemId,
				);
				if (!workItem)
					throw new ElizaError(
						"Persisted organization reassignment targets missing work",
						{ code: "ORGANIZATION_STORE_CORRUPT", severity: "fatal" },
					);
				workItem.assigneeMemberId = command.assigneeMemberId;
				workItem.status = "assigned";
				delete workItem.executionId;
				delete workItem.result;
				break;
			}
			case "complete_organization":
				organization.status = "completed";
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
	if (status !== "active" && status !== "completed") {
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
		members: Array.isArray(organization.members)
			? organization.members.map(persistedMember)
			: [],
		workItems: Array.isArray(organization.workItems)
			? organization.workItems.map(persistedWorkItem)
			: [],
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

	async list(): Promise<AgentOrganizationRecord[]> {
		await this.tail;
		return [...this.records.values()].map((record) => structuredClone(record));
	}

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
