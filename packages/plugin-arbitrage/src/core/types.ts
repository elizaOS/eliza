import { BigNumber } from "@ethersproject/bignumber";
import {
    MarketType as BaseMarketType,
    EthMarket as BaseEthMarket,
    MarketPair as BaseMarketPair,
    CrossedMarketDetails as BaseCrossedMarketDetails,
    MarketsByToken as BaseMarketsByToken,
    BuyCalls as BaseBuyCalls
} from "../type";

export type EthMarket = BaseEthMarket;
export type MarketPair = BaseMarketPair;
export type CrossedMarketDetails = BaseCrossedMarketDetails;
export type MarketsByToken = BaseMarketsByToken;
export type BuyCalls = BaseBuyCalls;
export type MarketType = BaseMarketType;