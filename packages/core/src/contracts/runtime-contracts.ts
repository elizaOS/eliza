/**
 * Public runtime-owned contracts shared with clients and infrastructure.
 * Runtime behavior stays in the adjacent domain modules; this barrel exposes
 * stable shapes and literal vocabularies without a separate package.
 */

export type {
	ConnectorAdminWhitelist,
	RoleGrantSource,
	RoleName,
	RolesConfig,
	RolesWorldMetadata,
} from "../roles.js";

export * from "./wallet-types.js";
