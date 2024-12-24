import { Coinbase } from "@coinbase/coinbase-sdk";
import { z } from "zod";
import { WebhookEventType, WebhookEventFilter, WebhookEventTypeFilter } from "@coinbase/coinbase-sdk/dist/client";

export const ChargeSchema = z.object({
    id: z.string().nullable(),
    price: z.number(),
    type: z.string(),
    currency: z.string().min(3).max(3),
    name: z.string().min(1),
    description: z.string().min(1),
});

export interface ChargeContent {
    id: string | null;
    price: number;
    type: string;
    currency: string; // Currency code (e.g., USD)
    name: string; // Name of the charge
    description: string; // Description of the charge
}

export const isChargeContent = (object: any): object is ChargeContent => {
    if (ChargeSchema.safeParse(object).success) {
        return true;
    }
    console.error("Invalid content: ", object);
    return false;
};

export const TransferSchema = z.object({
    network: z.string().toLowerCase(),
    receivingAddresses: z.array(z.string()),
    transferAmount: z.number(),
    assetId: z.string().toLowerCase(),
});

export interface TransferContent {
    network: string;
    receivingAddresses: string[];
    transferAmount: number;
    assetId: string;
}

export const isTransferContent = (object: any): object is TransferContent => {
    return TransferSchema.safeParse(object).success;
};

export type Transaction = {
    address: string;
    amount: number;
    status: string;
    errorCode: string | null;
    transactionUrl: string | null;
};
const assetValues = Object.values(Coinbase.assets) as [string, ...string[]];
export const TradeSchema = z.object({
    network: z.string().toLowerCase(),
    amount: z.number(),
    sourceAsset: z.enum(assetValues),
    targetAsset: z.enum(assetValues),
    side: z.enum(["BUY", "SELL"]),
});

export interface TradeContent {
    network: string;
    amount: number;
    sourceAsset: string;
    targetAsset: string;
    side: "BUY" | "SELL";

}

export const isTradeContent = (object: any): object is TradeContent => {
    return TradeSchema.safeParse(object).success;
};

export type TradeTransaction = {
    network: string;
    amount: number;
    sourceAsset: string;
    targetAsset: string;
    status: string;
    errorCode: string | null;
    transactionUrl: string | null;
};

export interface TokenContractContent {
    contractType: "ERC20" | "ERC721" | "ERC1155";
    name: string;
    symbol: string;
    network: string;
    baseURI?: string;
    totalSupply?: number;
}

export const TokenContractSchema = z.object({
    contractType: z.enum(["ERC20", "ERC721", "ERC1155"]).describe("The type of token contract to deploy"),
    name: z.string().describe("The name of the token"),
    symbol: z.string().describe("The symbol of the token"),
    network: z.string().describe("The blockchain network to deploy on"),
    baseURI: z.string().optional().describe("The base URI for token metadata (required for ERC721 and ERC1155)"),
    totalSupply: z.number().optional().describe("The total supply of tokens (only for ERC20)"),
}).refine(data => {
    if (data.contractType === "ERC20") {
        return typeof data.totalSupply === "number" || data.totalSupply === undefined;
    }
    if (["ERC721", "ERC1155"].includes(data.contractType)) {
        return typeof data.baseURI === "string" || data.baseURI === undefined;
    }
    return true;
}, {
    message: "Invalid token contract content",
    path: ["contractType"],
});

export const isTokenContractContent = (obj: any): obj is TokenContractContent => {
    return TokenContractSchema.safeParse(obj).success;
};

// Add to types.ts
export interface ContractInvocationContent {
    contractAddress: string;
    method: string;
    abi: any[];
    args?: Record<string, any>;
    amount?: string;
    assetId: string;
    networkId: string;
}

export const ContractInvocationSchema = z.object({
    contractAddress: z.string().describe("The address of the contract to invoke"),
    method: z.string().describe("The method to invoke on the contract"),
    abi: z.array(z.any()).describe("The ABI of the contract"),
    args: z.record(z.string(), z.any()).optional().describe("The arguments to pass to the contract method"),
    amount: z.string().optional().describe("The amount of the asset to send (as string to handle large numbers)"),
    assetId: z.string().describe("The ID of the asset to send (e.g., 'USDC')"),
    networkId: z.string().describe("The network ID to use (e.g., 'ethereum-mainnet')")
});

export const isContractInvocationContent = (obj: any): obj is ContractInvocationContent => {
    return ContractInvocationSchema.safeParse(obj).success;
};


export const WebhookSchema = z.object({
    networkId: z.string(),
    eventType: z.nativeEnum(WebhookEventType),
    eventTypeFilter:z.custom<WebhookEventTypeFilter>().optional(),
    eventFilters: z.array(z.custom<WebhookEventFilter>()).optional()
});

export type WebhookContent = z.infer<typeof WebhookSchema>;

export const isWebhookContent = (object: any): object is WebhookContent => {
    return WebhookSchema.safeParse(object).success;
};

export const AdvancedTradeSchema = z.object({
    productId: z.string(),
    side: z.enum(["BUY", "SELL"]),
    amount: z.number(),
    orderType: z.enum(["MARKET", "LIMIT"]),
    limitPrice: z.number().optional(),
});

export interface AdvancedTradeContent {
    productId: string;
    side: "BUY" | "SELL";
    amount: number;
    orderType: "MARKET" | "LIMIT";
    limitPrice?: number;
}

export const isAdvancedTradeContent = (object: any): object is AdvancedTradeContent => {
    return AdvancedTradeSchema.safeParse(object).success;
};

export interface ReadContractContent {
    contractAddress: `0x${string}`;
    method: string;
    networkId: string;
    args: Record<string, any>;
    abi?: any[];
}

export const ReadContractSchema = z.object({
    contractAddress: z.string().describe("The address of the contract to read from"),
    method: z.string().describe("The view/pure method to call on the contract"),
    networkId: z.string().describe("The network ID to use"),
    args: z.record(z.string(), z.any()).describe("The arguments to pass to the contract method"),
    abi: z.array(z.any()).optional().describe("The contract ABI (optional)")
});

export const isReadContractContent = (obj: any): obj is ReadContractContent => {
    return ReadContractSchema.safeParse(obj).success;
};

// Bridge types
export interface BridgeContent {
    sourceWalletId: string;
    destinationWalletId: string;
    amount: string;
    token: string;
}

export interface BridgeRecord {
    sourceChain: string;
    destinationChain: string;
    amount: string;
    token: string;
    status: string;
    sourceTransactionHash: string;
    destinationTransactionHash: string;
    timestamp: string;
}

export const BridgeSchema = z.object({
    sourceWalletId: z.string().describe("The ID of the source wallet"),
    destinationWalletId: z.string().describe("The ID of the destination wallet"),
    amount: z.string().describe("The amount to bridge"),
    token: z.string().describe("The token symbol to bridge (e.g., USDC)")
});

export const isBridgeContent = (obj: any): obj is BridgeContent => {
    return BridgeSchema.safeParse(obj).success;
};