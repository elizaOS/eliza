/**
 * Connector account policy primitives shared without importing component implementations.
 */

export type ConnectorAccountRole = "OWNER" | "AGENT" | "TEAM" | (string & {});

export type ConnectorAccountPurpose =
	| "messaging"
	| "posting"
	| "reading"
	| "admin"
	| "automation"
	| (string & {});

export type ConnectorAccountAccessGate =
	| "open"
	| "pairing"
	| "owner_binding"
	| "manual_approval"
	| "disabled"
	| (string & {});

export type ConnectorAccountStatus =
	| "connected"
	| "pending"
	| "disabled"
	| "revoked"
	| "error";

export interface ConnectorAccountPolicy {
	provider: string;
	roles?: ConnectorAccountRole[];
	purposes?: ConnectorAccountPurpose[];
	accessGates?: ConnectorAccountAccessGate[];
	statuses?: ConnectorAccountStatus[];
	accountIdParam?: string;
	required?: boolean;
}
