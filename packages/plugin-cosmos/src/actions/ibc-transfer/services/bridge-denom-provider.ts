import type { IDenomProvider } from "../../../shared/interfaces";
import { SkipApiAssetsFromSourceFetcher } from "../../../shared/services/skip-api/assets-from-source-fetcher/skip-api-assets-from-source-fetcher";

export const bridgeDenomProvider: IDenomProvider = async (
    sourceAssetDenom: string,
    sourceAssetChainId: string,
    destChainId: string
) => {
    const skipApiAssetsFromSourceFetcher =
        SkipApiAssetsFromSourceFetcher.getInstance();
    const bridgeData = await skipApiAssetsFromSourceFetcher.fetch(
        sourceAssetDenom,
        sourceAssetChainId
    );

    const destAssets = bridgeData.dest_assets[destChainId];

    if (!destAssets?.assets) {
        throw new Error(`No assets found for chain ${destChainId}`);
    }

    const ibcAssetData = destAssets.assets?.find(
        ({ origin_denom }) => origin_denom === sourceAssetDenom
    );

    if (!ibcAssetData) {
        throw new Error(`No matching asset found for denom ${sourceAssetDenom}`);
    }

    if (!ibcAssetData.denom) {
        throw new Error("No IBC asset data");
    }

    return {
        denom: ibcAssetData.denom,
    };
};
