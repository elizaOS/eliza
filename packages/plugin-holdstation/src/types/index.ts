import { Content } from "@elizaos/core";
import { Address } from "viem";

export interface SwapParams extends Content {
    inputTokenCA?: Address;
    inputTokenSymbol?: string;
    outputTokenCA?: Address;
    outputTokenSymbol?: string;
    amount: bigint;
    slippage?: number;
}

export interface SendTransactionParams {
    to: Address;
    data: string;
    value?: bigint;
    nonce: number;
}

export interface Item {
    name: string;
    address: Address;
    symbol: string;
    decimals: number;
}

export interface WalletPortfolio {
    items: Array<Item>;
}
