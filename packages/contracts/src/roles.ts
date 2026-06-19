/**
 * Role / ownership type contracts.
 *
 * The elizaOS role hierarchy (OWNER > ADMIN > USER > GUEST) and the
 * connector-admin whitelist used to promote connector users to ADMIN.
 * Pure types only — role-resolution logic lives in @elizaos/core/roles.
 */

export type RoleName = 'OWNER' | 'ADMIN' | 'USER' | 'GUEST';

export type RoleGrantSource = 'owner' | 'manual' | 'connector_admin';

export type RolesWorldMetadata = {
	ownership?: { ownerId?: string };
	roles?: Record<string, RoleName>;
	roleSources?: Record<string, RoleGrantSource>;
};

export type ConnectorAdminWhitelist = Record<string, string[]>;

export type RolesConfig = {
	connectorAdmins?: ConnectorAdminWhitelist;
};
