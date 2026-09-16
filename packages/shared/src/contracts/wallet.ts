/**
 * Compatibility facade for runtime-owned wallet contracts and normalizers.
 *
 * The shared-package path is retained while core remains the sole executable
 * owner of RPC selection and update-request behavior.
 */
export * from "@elizaos/core/contracts/wallet";
