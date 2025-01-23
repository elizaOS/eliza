import axios from "axios";
import { skipApiAssetsFromSourceResponseSchema } from "./schema";
import type {
    SkipApiAssetsFromSourceParams,
    SkipApiAssetsFromSourceResponse,
} from "./interfaces";
import { skipApiBaseUrl } from "../config";

type CacheKey = `${string}_${string}`;
const endpointPath = "fungible/assets_from_source";

export class SkipApiAssetsFromSourceFetcher {
    private static instance: SkipApiAssetsFromSourceFetcher;
    private cache: Map<CacheKey, SkipApiAssetsFromSourceResponse>;
    private readonly apiUrl: string;

    private constructor() {
        this.cache = new Map();
        this.apiUrl = `${skipApiBaseUrl}${endpointPath}`;
    }

    public static getInstance(): SkipApiAssetsFromSourceFetcher {
        if (!SkipApiAssetsFromSourceFetcher.instance) {
            SkipApiAssetsFromSourceFetcher.instance =
                new SkipApiAssetsFromSourceFetcher();
        }
        return SkipApiAssetsFromSourceFetcher.instance;
    }

    private generateCacheKey(
        sourceAssetDenom: string,
        sourceAssetChainId: string
    ): CacheKey {
        return `${sourceAssetDenom}_${sourceAssetChainId}`;
    }

    public async fetch(
        sourceAssetDenom: string,
        sourceAssetChainId: string
    ): Promise<SkipApiAssetsFromSourceResponse> {
        const cacheKey = this.generateCacheKey(
            sourceAssetDenom,
            sourceAssetChainId
        );

        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey)!;
        }

        const requestData: SkipApiAssetsFromSourceParams = {
            source_asset_denom: sourceAssetDenom,
            source_asset_chain_id: sourceAssetChainId,
            allow_multi_tx: false,
        };

        try {
            const response = await axios.post(this.apiUrl, requestData, {
                headers: {
                    "Content-Type": "application/json",
                },
                timeout: 5000,
            });

            const validResponse = skipApiAssetsFromSourceResponseSchema.parse(
                response.data
            );

            this.cache.set(cacheKey, validResponse);
            return response.data;
        } catch (error) {
            console.error("Error fetching assets:", error);
            throw error;
        }
    }
}
