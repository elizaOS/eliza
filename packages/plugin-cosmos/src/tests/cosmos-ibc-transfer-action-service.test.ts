import { describe, it, expect, vi, beforeEach } from "vitest";
import { IBCTransferAction } from "../actions/ibc-transfer/services/ibc-transfer-action-service";
import { assets } from "chain-registry";
import * as CosmosAssetsHelpers from "../shared/helpers/cosmos-assets";
import { getAssetBySymbol } from "@chain-registry/utils";
import { getAvailableAssets } from "../shared/helpers/cosmos-assets";

vi.mock("@chain-registry/utils", () => ({
    getAssetBySymbol: vi.fn(),
    getChainByChainName: vi.fn((_, chainName: string) => {
        if (chainName === "test-chain") return { chain_id: "source-chain-id" };
        return { chain_id: "target-chain-id" };
    }),
    convertDisplayUnitToBaseUnit: vi.fn(() => "1"),
    getChainByChainId: vi.fn(() => ({ chainId: "target-chain-id" })),
}));

vi.mock("../shared/helpers/cosmos-assets", () => ({
    getAvailableAssets: vi.fn(),
}));

describe("IBCTransferAction", () => {
    const mockWalletChains = {
        getWalletAddress: vi.fn(),
        getSkipClient: vi.fn(),
    };

    const mockBridgeDenomProvider = vi.fn();
    const mockSkipClient = {
        route: vi.fn(),
        executeRoute: vi.fn(),
    };

    const params = {
        chainName: "test-chain",
        targetChainName: "target-chain",
        symbol: "ATOM",
        amount: "10",
        toAddress: "cosmos1receiveraddress",
    };

    const customChainAssets = [];

    beforeEach(() => {
        vi.clearAllMocks();
        mockWalletChains.getSkipClient.mockReturnValue(mockSkipClient);
    });

    it("throws an error if sender address is not available", async () => {
        mockWalletChains.getWalletAddress.mockResolvedValue(null);
        // @ts-expect-error --- ...
        const ibcTransferAction = new IBCTransferAction(mockWalletChains);

        await expect(
            ibcTransferAction.execute(
                params,
                mockBridgeDenomProvider,
                customChainAssets
            )
        ).rejects.toThrow(
            `Cannot get wallet address for chain ${params.chainName}`
        );
    });

    it("throws an error if receiver address is missing", async () => {
        const invalidParams = { ...params, toAddress: undefined };
        mockWalletChains.getWalletAddress.mockResolvedValue(
            "cosmos1senderaddress"
        );
        // @ts-expect-error --- ...
        const ibcTransferAction = new IBCTransferAction(mockWalletChains);

        await expect(
            ibcTransferAction.execute(
                invalidParams,
                mockBridgeDenomProvider,
                customChainAssets
            )
        ).rejects.toThrow("No receiver address");
    });

    it("throws an error if target chain name is missing", async () => {
        const invalidParams = { ...params, targetChainName: undefined };
        mockWalletChains.getWalletAddress.mockResolvedValue(
            "cosmos1senderaddress"
        );
        // @ts-expect-error --- ...
        const ibcTransferAction = new IBCTransferAction(mockWalletChains);

        await expect(
            ibcTransferAction.execute(
                invalidParams,
                mockBridgeDenomProvider,
                customChainAssets
            )
        ).rejects.toThrow("No target chain name");
    });

    it("throws an error if symbol is missing", async () => {
        const invalidParams = { ...params, symbol: undefined };
        mockWalletChains.getWalletAddress.mockResolvedValue(
            "cosmos1senderaddress"
        );
        // @ts-expect-error --- ...
        const ibcTransferAction = new IBCTransferAction(mockWalletChains);

        await expect(
            ibcTransferAction.execute(
                invalidParams,
                mockBridgeDenomProvider,
                customChainAssets
            )
        ).rejects.toThrow("No symbol");
    });

    it("throws an error if asset cannot be found", async () => {
        mockWalletChains.getWalletAddress.mockResolvedValue(
            "cosmos1senderaddress"
        );

        vi.spyOn(CosmosAssetsHelpers, "getAvailableAssets").mockReturnValue([]);
        // @ts-expect-error --- ...
        getAssetBySymbol.mockReturnValue({
            base: null,
        });

        // @ts-expect-error --- ...
        const ibcTransferAction = new IBCTransferAction(mockWalletChains);

        await expect(
            ibcTransferAction.execute(
                params,
                mockBridgeDenomProvider,
                customChainAssets
            )
        ).rejects.toThrow("Cannot find asset");
    });

    it("executes the IBC transfer successfully", async () => {
        const senderAddress = "cosmos1senderaddress";
        const targetChainId = "target-chain-id";
        const sourceChainId = "source-chain-id";
        const mockTxHash = "mock_tx_hash_123";

        mockWalletChains.getWalletAddress.mockResolvedValue(senderAddress);
        // @ts-expect-error --- ...
        getAvailableAssets.mockReturnValue(assets);

        // @ts-expect-error --- ...
        getAssetBySymbol.mockReturnValue({
            base: "uatom",
        });
        const params = {
            chainName: "test-chain",
            targetChainName: "target-chain",
            symbol: "ATOM",
            amount: "10",
            toAddress: "cosmos1receiveraddress",
        };

        mockBridgeDenomProvider.mockResolvedValue({ denom: "uatom" });
        mockSkipClient.route.mockResolvedValue({
            requiredChainAddresses: [sourceChainId, targetChainId],
        });
        mockSkipClient.executeRoute.mockImplementation(async ({ onTransactionCompleted }) => {
            await onTransactionCompleted(null, mockTxHash);
        });

        // @ts-expect-error --- ...
        const ibcTransferAction = new IBCTransferAction(mockWalletChains);

        const result = await ibcTransferAction.execute(
            params,
            mockBridgeDenomProvider,
            customChainAssets
        );

        expect(result).toEqual({
            from: senderAddress,
            to: params.toAddress,
            txHash: mockTxHash,
        });
        expect(mockSkipClient.executeRoute).toHaveBeenCalled();
    });
});
