import { Content } from "@elizaos/core";
import { z } from "zod";

export const StakeParamsSchema = z.object({
    poolName: z.string().or(z.null()),
    userAddress: z.string(),
    amountSol: z.number().or(z.string()),
});

export interface StakeParams extends Content {
    poolName: string;
    userAddress: string;
    amountSol: number | string;
}

export const SelectedPoolSchema = z.object({
    selectedPool: z.string(),
    reason: z.string(),
});

export interface SelectedPool extends Content {
    selectedPool: string;
    reason: string;
}

export interface StakePool {
    readonly address: string;
    readonly protocolName: string;
}

export type StakePoolsType = {
    readonly [key: string]: StakePool;
};

export interface StakeConfig {
    name: string;
    similes: string[];
    pools: {
        [key: string]: StakePool;
    };
}

export interface StakePoolInfo {
    totalApy: number;
    tvl: number;
    miningApy: number;
    airdropExpectation: string;
    protocolName: string;
}

export interface StakeProtocolData {
    pools: Record<string, StakePoolInfo>;
    timestamp: number;
}