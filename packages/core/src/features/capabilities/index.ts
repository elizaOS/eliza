/**
 * Public barrel for the durable capability-grant feature (#23102): the typed
 * vocabulary and decision contracts, the self-migrating grant/audit store,
 * the canonical `authorizeCapability` decision path, and the checked-in
 * enforcement-boundary inventory. Authorization data is intentionally kept
 * separate from the trust feature; nothing here imports trust code.
 */

export { authorizeCapability } from "./authorizeCapability.ts";
export type {
	AuditAppendInput,
	AuditRow,
	CapabilityStoreDb,
	RevokeGrantResult,
	UpdateGrantResult,
} from "./CapabilityGrantStore.ts";
export {
	appendCapabilityAudit,
	createCapabilityGrant,
	ensureCapabilityGrantTables,
	getCapabilityEpoch,
	getCapabilityGrant,
	listCapabilityAudit,
	listLiveGrantsFor,
	revokeCapabilityGrant,
	updateCapabilityGrant,
} from "./CapabilityGrantStore.ts";
export { CAPABILITY_BOUNDARY_INVENTORY } from "./capability-boundary-inventory.ts";
export * from "./types.ts";
