/**
 * Connector account primitive types extracted here so that types/components.ts
 * can reference ConnectorAccountPolicy without a circular import through
 * connectors/account-manager.ts.
 *
 * connectors/account-manager.ts re-exports everything from this module.
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
