/**
 * Unit tests for wallet RPC configuration contracts and normalizers.
 * Validates RPC provider options, aliases resolution, and selection normalizers.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_WALLET_RPC_SELECTIONS,
	normalizeWalletRpcProviderId,
	normalizeWalletRpcSelections,
	WALLET_RPC_PROVIDER_OPTIONS,
} from "../contracts/wallet.ts";

describe("wallet contracts", () => {
	describe("constants", () => {
		it("defines default wallet RPC selections", () => {
			expect(DEFAULT_WALLET_RPC_SELECTIONS).toEqual({
				evm: "eliza-cloud",
				bsc: "eliza-cloud",
				solana: "eliza-cloud",
			});
		});

		it("registers provider options for EVM, BSC, and Solana chains", () => {
			expect(WALLET_RPC_PROVIDER_OPTIONS.evm.map((o) => o.id)).toContain(
				"eliza-cloud",
			);
			expect(WALLET_RPC_PROVIDER_OPTIONS.evm.map((o) => o.id)).toContain(
				"alchemy",
			);
			expect(WALLET_RPC_PROVIDER_OPTIONS.bsc.map((o) => o.id)).toContain(
				"nodereal",
			);
			expect(WALLET_RPC_PROVIDER_OPTIONS.solana.map((o) => o.id)).toContain(
				"helius-birdeye",
			);
		});
	});

	describe("normalizeWalletRpcProviderId", () => {
		it("resolves valid provider IDs across chains", () => {
			expect(normalizeWalletRpcProviderId("evm", "alchemy")).toBe("alchemy");
			expect(normalizeWalletRpcProviderId("evm", "infura")).toBe("infura");
			expect(normalizeWalletRpcProviderId("bsc", "quicknode")).toBe(
				"quicknode",
			);
			expect(normalizeWalletRpcProviderId("solana", "helius-birdeye")).toBe(
				"helius-birdeye",
			);
		});

		it("resolves aliases correctly", () => {
			expect(normalizeWalletRpcProviderId("evm", "elizacloud")).toBe(
				"eliza-cloud",
			);
			expect(normalizeWalletRpcProviderId("bsc", "elizacloud")).toBe(
				"eliza-cloud",
			);
			expect(normalizeWalletRpcProviderId("solana", "helius")).toBe(
				"helius-birdeye",
			);
		});

		it("returns null for mismatched chains or invalid provider IDs", () => {
			expect(normalizeWalletRpcProviderId("evm", "nodereal")).toBeNull();
			expect(normalizeWalletRpcProviderId("solana", "alchemy")).toBeNull();
			expect(
				normalizeWalletRpcProviderId("evm", "unknown-provider"),
			).toBeNull();
			expect(normalizeWalletRpcProviderId("evm", "")).toBeNull();
			expect(normalizeWalletRpcProviderId("evm", null)).toBeNull();
			expect(normalizeWalletRpcProviderId("evm", undefined)).toBeNull();
		});
	});

	describe("normalizeWalletRpcSelections", () => {
		it("normalizes valid selections and applies defaults for missing fields", () => {
			const selections = normalizeWalletRpcSelections({
				evm: "alchemy",
				solana: "helius",
			});

			expect(selections).toEqual({
				evm: "alchemy",
				bsc: "eliza-cloud",
				solana: "helius-birdeye",
			});
		});

		it("falls back to full default selection when input is empty or null", () => {
			expect(normalizeWalletRpcSelections(null)).toEqual(
				DEFAULT_WALLET_RPC_SELECTIONS,
			);
			expect(normalizeWalletRpcSelections(undefined)).toEqual(
				DEFAULT_WALLET_RPC_SELECTIONS,
			);
			expect(normalizeWalletRpcSelections({})).toEqual(
				DEFAULT_WALLET_RPC_SELECTIONS,
			);
		});
	});
});
