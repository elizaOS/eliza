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

		it("trims surrounding whitespace and folds case before matching", () => {
			expect(normalizeWalletRpcProviderId("evm", "  Alchemy ")).toBe("alchemy");
			expect(normalizeWalletRpcProviderId("bsc", "QUICKNODE")).toBe(
				"quicknode",
			);
			expect(normalizeWalletRpcProviderId("evm", "\tinfura\n")).toBe("infura");
		});

		it("applies aliases after trimming and lowercasing", () => {
			expect(normalizeWalletRpcProviderId("evm", "  ELIZACLOUD  ")).toBe(
				"eliza-cloud",
			);
			expect(normalizeWalletRpcProviderId("solana", "\tHelius\n")).toBe(
				"helius-birdeye",
			);
			expect(normalizeWalletRpcProviderId("bsc", "ElizaCloud")).toBe(
				"eliza-cloud",
			);
		});

		it("rejects whitespace-only values and truthy non-string inputs", () => {
			expect(normalizeWalletRpcProviderId("evm", "   ")).toBeNull();
			expect(normalizeWalletRpcProviderId("bsc", "\t\n")).toBeNull();
			expect(
				normalizeWalletRpcProviderId("evm", 42 as unknown as string),
			).toBeNull();
			expect(
				normalizeWalletRpcProviderId("solana", {
					id: "alchemy",
				} as unknown as string),
			).toBeNull();
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

		it("falls back per chain while preserving valid selections", () => {
			expect(
				normalizeWalletRpcSelections({
					evm: "not-a-provider",
					bsc: "quicknode",
					solana: "HELIUS",
				}),
			).toEqual({
				evm: "eliza-cloud",
				bsc: "quicknode",
				solana: "helius-birdeye",
			});
		});

		it("treats explicit null and undefined fields as missing", () => {
			expect(
				normalizeWalletRpcSelections({
					evm: null,
					bsc: "ankr",
					solana: undefined,
				}),
			).toEqual({
				evm: "eliza-cloud",
				bsc: "ankr",
				solana: "eliza-cloud",
			});
		});
	});
});
