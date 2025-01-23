import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { IBCSwapAction } from "../actions/ibc-swap/services/ibc-swap-action-service.ts";
import { HandlerCallback } from "@elizaos/core";
import { getAssetBySymbol, getDenomBySymbol } from "@chain-registry/utils";
import { Asset } from "@chain-registry/types";

vi.mock("@cosmjs/cosmwasm-stargate", () => ({
    SigningCosmWasmClient: {
        connectWithSigner: vi.fn(),
    },
}));

vi.mock("@chain-registry/utils", () => ({
    getAssetBySymbol: vi.fn(),
    getChainByChainName: vi.fn((_, chainName: string) => {
        if (chainName === "source-chain")
            return { chain_id: "source-chain-id" };
        return { chain_id: "target-chain-id" };
    }),
    getChainNameByChainId: vi.fn((_, chainId: string) => {
        if (chainId === "source-chain-id") return "source-chain";
        return "target-chain";
    }),
    getDenomBySymbol: vi.fn((_, symbol: string) => {
        if (symbol === "fromTokenSymbol") return "fromTokenDenom";
        else if (symbol === "toTokenSymbol") return "toTokenDenom";
    }),
    getExponentByDenom: vi.fn((_, denom: string) => {
        if (denom === "fromTokenDenom") return "6";
    }),
    convertDisplayUnitToBaseUnit: vi.fn(() => "1000000"),
    getChainByChainId: vi.fn(() => ({ chainId: "target-chain-id" })),
}));
describe("IBCSwapAction", () => {
    const mockWalletChains = {
        getWalletAddress: vi.fn(),
        getSkipClient: vi.fn(),
        walletChainsData: {},
        getSigningCosmWasmClient: vi.fn(),
    };

    const mockSkipClient = {
        route: vi.fn(),
        executeRoute: vi.fn(),
    };

    const params = {
        fromChainName: "source-chain",
        fromTokenSymbol: "fromTokenSymbol",
        fromTokenAmount: "1000",
        toChainName: "target-chain",
        toTokenSymbol: "toTokenSymbol",
    };

    const _callback: Mock<HandlerCallback> = vi.fn();

    const customChainAssets = [];

    beforeEach(() => {
        vi.clearAllMocks();
        (mockWalletChains.getSkipClient as Mock).mockReturnValue(
            mockSkipClient
        );
    });

    it("should complete", async () => {
        // Mock wallet addresses
        (mockWalletChains.getWalletAddress as Mock)
            .mockImplementationOnce(() => "source-chain-address")
            .mockImplementationOnce(() => "target-chain-address");

        // Mock route call, including `requiredChainAddresses`
        (mockSkipClient.route as Mock).mockResolvedValue({
            estimatedAmountOut: "123",
            estimatedFees: "1",
            estimatedRouteDurationSeconds: "1",
            requiredChainAddresses: ["source-chain-id", "target-chain-id"],
        });

        // Mock asset symbols
        (getAssetBySymbol as Mock).mockImplementation((symbol: string) => {
            if (symbol === "fromTokenSymbol") {
                return { asset: { base: "fromTokenDenom" } };
            }
            if (symbol === "toTokenSymbol") {
                return { asset: { base: "toTokenDenom" } };
            }
            return null;
        });

        // Mock `executeRoute` to simulate transaction completion
        (mockSkipClient.executeRoute as Mock).mockImplementation(
            ({ onTransactionCompleted }) => {
                onTransactionCompleted("target-chain-id", "mockTxHash", {
                    state: "success",
                });
            }
        );

        const ibcSwapAction = new IBCSwapAction(mockWalletChains);

        // Execute the action
        const result = await ibcSwapAction.execute(
            params,
            customChainAssets,
            _callback
        );

        // Validate the route call
        expect(mockSkipClient.route).toHaveBeenCalledWith({
            smartSwapOptions: {},
            amountOut: "1000000",
            sourceAssetDenom: "fromTokenDenom",
            sourceAssetChainID: "source-chain-id",
            destAssetDenom: "toTokenDenom",
            destAssetChainID: "target-chain-id",
        });

        // Validate the callback
        expect(_callback).toHaveBeenCalledWith({
            text: `Expected swap result: 123 ${params.toTokenSymbol}, \nEstimated Fee: 1. \nEstimated time: 1`,
        });

        // Validate the final result
        expect(result).toEqual({
            fromChainName: params.fromChainName,
            fromTokenAmount: params.fromTokenAmount,
            fromTokenSymbol: params.fromTokenSymbol,
            toChainName: params.toChainName,
            toTokenSymbol: params.toTokenSymbol,
            txHash: "mockTxHash",
            status: "success",
        });
    });

    it("should throw an error if route fails", async () => {
        // Mock route failure
        (mockSkipClient.route as Mock).mockRejectedValue(
            new Error("Route failed")
        );

        const ibcSwapAction = new IBCSwapAction(mockWalletChains);

        await expect(
            ibcSwapAction.execute(params, customChainAssets, _callback)
        ).rejects.toThrow("Route failed");
    });

    it("should handle transaction failure during execution", async () => {
        // Mock successful route call
        (mockSkipClient.route as Mock).mockResolvedValue({
            estimatedAmountOut: "123",
            estimatedFees: "1",
            estimatedRouteDurationSeconds: "1",
            requiredChainAddresses: ["source-chain-id", "target-chain-id"],
        });

        // Mock transaction failure
        (mockSkipClient.executeRoute as Mock).mockImplementation(
            ({ onTransactionCompleted }) => {
                onTransactionCompleted("target-chain-id", "mockTxHash", {
                    state: "failure",
                });
            }
        );

        const ibcSwapAction = new IBCSwapAction(mockWalletChains);

        const result = await ibcSwapAction.execute(
            params,
            customChainAssets,
            _callback
        );

        // Validate the final result
        expect(result).toEqual({
            status: "failure",
            fromChainName: params.fromChainName,
            fromTokenAmount: params.fromTokenAmount,
            fromTokenSymbol: params.fromTokenSymbol,
            toChainName: params.toChainName,
            toTokenSymbol: params.toTokenSymbol,
            txHash: "mockTxHash",
        });

    });

    it("should complete without callback", async () => {
        // Mock wallet addresses
        (mockWalletChains.getWalletAddress as Mock)
            .mockImplementationOnce(() => "source-chain-address")
            .mockImplementationOnce(() => "target-chain-address");

        // Mock route call
        (mockSkipClient.route as Mock).mockResolvedValue({
            estimatedAmountOut: "123",
            estimatedFees: "1",
            estimatedRouteDurationSeconds: "1",
            requiredChainAddresses: ["source-chain-id", "target-chain-id"],
        });

        // Mock transaction completion
        (mockSkipClient.executeRoute as Mock).mockImplementation(
            ({ onTransactionCompleted }) => {
                onTransactionCompleted("target-chain-id", "mockTxHash", {
                    state: "success",
                });
            }
        );

        const ibcSwapAction = new IBCSwapAction(mockWalletChains);

        // Execute without callback
        const result = await ibcSwapAction.execute(params, customChainAssets);

        expect(result).toEqual({
            "status": "success",
            fromChainName: params.fromChainName,
            fromTokenAmount: params.fromTokenAmount,
            fromTokenSymbol: params.fromTokenSymbol,
            toChainName: params.toChainName,
            toTokenSymbol: params.toTokenSymbol,
            txHash: "mockTxHash",
        });
    });

    it("should use custom chain assets when provided", async () => {
        const customAssets = [
            {
                chain_name: "source-chain",
                assets: [
                    {
                        symbol: "fromTokenSymbol",
                        denom: "customFromDenom",
                    } as unknown as Asset,
                ],
            },
            {
                chain_name: "target-chain",
                assets: [
                    {
                        symbol: "toTokenSymbol",
                        denom: "customToDenom",
                    } as unknown as Asset,
                ],
            },
        ];

        (getDenomBySymbol as Mock).mockImplementation((assets, symbol) => {
            if (symbol === "fromTokenSymbol") return "customFromDenom";
            if (symbol === "toTokenSymbol") return "customToDenom";
        });

        // Mock route call
        (mockSkipClient.route as Mock).mockResolvedValue({
            estimatedAmountOut: "123",
            estimatedFees: "1",
            estimatedRouteDurationSeconds: "1",
            requiredChainAddresses: ["source-chain-id", "target-chain-id"],
        });

        // Mock transaction completion
        (mockSkipClient.executeRoute as Mock).mockImplementation(
            ({ onTransactionCompleted }) => {
                onTransactionCompleted("target-chain-id", "mockTxHash", {
                    state: "success",
                });
            }
        );

        const ibcSwapAction = new IBCSwapAction(mockWalletChains);

        const result = await ibcSwapAction.execute(
            params,
            customAssets,
            _callback
        );

        expect(result).toEqual({
            "status": "success",
            fromChainName: params.fromChainName,
            fromTokenAmount: params.fromTokenAmount,
            fromTokenSymbol: params.fromTokenSymbol,
            toChainName: params.toChainName,
            toTokenSymbol: params.toTokenSymbol,
            txHash: "mockTxHash",
        });

        expect(getDenomBySymbol).toHaveBeenCalledWith(
            expect.anything(),
            "fromTokenSymbol",
            "source-chain"
        );
        expect(getDenomBySymbol).toHaveBeenCalledWith(
            expect.anything(),
            "toTokenSymbol",
            "target-chain"
        );
    });
});
