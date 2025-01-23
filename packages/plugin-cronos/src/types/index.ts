import type { Hex, Chain } from "viem";
import { z } from "zod";

export type CronosChain = "cronos" | "cronosTestnet";

export interface Transaction {
    hash: Hex;
    from: Hex;
    to: Hex;
    value: bigint;
    data: Hex;
    chainId?: number;
}

export interface TransferParams {
    fromChain: CronosChain;
    toAddress: Hex;
    amount: string;
    data?: Hex;
}

export const BalanceParamsSchema = z.object({
    chain: z.enum(["cronos", "cronosTestnet"] as const),
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format"),
});

export interface BalanceParams {
    chain: CronosChain;
    address: Hex;
}

export interface WalletConfig {
    chains: Record<CronosChain, Chain>;
    privateKey: Hex;
}

export interface CronosProvider {
    get(runtime: any, message: any, state?: any): Promise<string | null>;
}