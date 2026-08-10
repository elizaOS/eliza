/**
 * Credential-free, agent-scoped connector binding projection shared by
 * connector materializers, policy checks, and product-facing APIs. The source
 * account may carry private storage metadata; this projection intentionally
 * exposes only identity, authorization posture, and granted capabilities.
 */

import type {
	ConnectorAccountAccessGate,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAccountStatus,
} from "../types/connector-account-policy";
import type { UUID } from "../types/primitives";
import type { ConnectorAccount } from "./account-manager";

export interface AgentConnectorBinding {
	id: string;
	agentId: UUID;
	provider: string;
	label?: string;
	role: ConnectorAccountRole;
	purposes: ConnectorAccountPurpose[];
	accessGate: ConnectorAccountAccessGate;
	status: ConnectorAccountStatus;
	selectedProducts: string[];
	allowedCapabilities: string[];
	grantedScopes: string[];
	externalIdentity?: {
		id?: string;
		displayHandle?: string;
	};
	ownerBinding?: {
		id?: string;
		identityId?: string;
	};
	isDefault: boolean;
	createdAt: number;
	updatedAt: number;
}

function optionalIdentity(
	id: string | undefined,
	displayHandle: string | undefined,
): AgentConnectorBinding["externalIdentity"] {
	if (!id && !displayHandle) return undefined;
	return {
		...(id ? { id } : {}),
		...(displayHandle ? { displayHandle } : {}),
	};
}

function optionalOwnerBinding(
	id: string | undefined,
	identityId: string | undefined,
): AgentConnectorBinding["ownerBinding"] {
	if (!id && !identityId) return undefined;
	return {
		...(id ? { id } : {}),
		...(identityId ? { identityId } : {}),
	};
}

export function projectAgentConnectorBinding(
	agentId: UUID,
	account: ConnectorAccount,
): AgentConnectorBinding {
	const externalIdentity = optionalIdentity(
		account.externalId,
		account.displayHandle,
	);
	const ownerBinding = optionalOwnerBinding(
		account.ownerBindingId,
		account.ownerIdentityId,
	);
	return {
		id: account.id,
		agentId,
		provider: account.provider,
		...(account.label ? { label: account.label } : {}),
		role: account.role,
		purposes: [...account.purpose],
		accessGate: account.accessGate,
		status: account.status,
		selectedProducts: [...(account.selectedProducts ?? [])],
		allowedCapabilities: [...(account.capabilities ?? [])],
		grantedScopes: [...(account.scopes ?? [])],
		...(externalIdentity ? { externalIdentity } : {}),
		...(ownerBinding ? { ownerBinding } : {}),
		isDefault: account.isDefault ?? false,
		createdAt: account.createdAt,
		updatedAt: account.updatedAt,
	};
}
