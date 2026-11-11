import { describe, expect, it } from "vitest";
import {
	lookupProviderCatalogContexts,
	resolveProviderContexts,
} from "../src/utils/context-catalog";

describe("lookupProviderCatalogContexts casing", () => {
	it("finds camelCase catalog entries under any casing", () => {
		// The catalog key is "walletBalance". Exact case works, but every
		// other casing misses and the provider falls back to ["general"].
		expect(lookupProviderCatalogContexts("walletBalance")).toEqual(["wallet"]);
		expect(lookupProviderCatalogContexts("WALLETBALANCE")).toEqual(["wallet"]);
		expect(lookupProviderCatalogContexts("WalletBalance")).toEqual(["wallet"]);
		expect(lookupProviderCatalogContexts("Walletbalance")).toEqual(["wallet"]);
	});

	it("finds other camelCase catalog entries under any casing", () => {
		expect(lookupProviderCatalogContexts("tokenPrices")).toEqual([
			"wallet",
			"documents",
		]);
		expect(lookupProviderCatalogContexts("TOKENPRICES")).toEqual([
			"wallet",
			"documents",
		]);
		expect(lookupProviderCatalogContexts("TokenPrices")).toEqual([
			"wallet",
			"documents",
		]);
		expect(lookupProviderCatalogContexts("chainInfo")).toEqual(["wallet"]);
		expect(lookupProviderCatalogContexts("CHAININFO")).toEqual(["wallet"]);
	});

	it("keeps working for keys that already resolved", () => {
		expect(lookupProviderCatalogContexts("time")).toEqual(["general"]);
		expect(lookupProviderCatalogContexts("TIME")).toEqual(["general"]);
		expect(lookupProviderCatalogContexts("solana-wallet")).toEqual(["wallet"]);
		expect(lookupProviderCatalogContexts("SOLANA-WALLET")).toEqual(["wallet"]);
	});

	it("still returns undefined for uncataloged providers", () => {
		expect(lookupProviderCatalogContexts("definitely-not-a-provider")).toBe(
			undefined,
		);
	});

	it("routes a differently-cased provider to its catalog contexts", () => {
		expect(resolveProviderContexts({ name: "WALLETBALANCE" })).toEqual([
			"wallet",
		]);
	});

	it("keeps declared contexts ahead of the catalog", () => {
		expect(
			resolveProviderContexts({ name: "WALLETBALANCE", contexts: ["general"] }),
		).toEqual(["general"]);
	});
});
