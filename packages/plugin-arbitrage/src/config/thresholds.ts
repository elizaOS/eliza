import { BigNumber } from "ethers";

export interface MarketThresholds {
    minProfitThreshold: BigNumber;
    maxTradeSize: BigNumber;
    gasLimit: number;
    minerRewardPercentage: number;
}

export const DEFAULT_THRESHOLDS: MarketThresholds = {
    minProfitThreshold: BigNumber.from("100000000000000"), // 0.0001 ETH
    maxTradeSize: BigNumber.from("1000000000000000000"), // 1 ETH
    gasLimit: 500000,
    minerRewardPercentage: 90
};