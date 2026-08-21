/**
 * Server-facing re-export of the canonical SDK redemption transport contract.
 * Keeping this compatibility path lets existing Cloud aliases consume one
 * implementation without making browser code import server-only modules.
 */

export * from "@elizaos/cloud-sdk/redemption-contract";
