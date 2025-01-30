import { BigNumber } from "@ethersproject/bignumber";
import { MarketType } from "../type";


export interface CallDetails {
    target: string;
    data: string;
    value?: BigNumber;
  }

  export interface TokenBalances {
    [tokenAddress: string]: BigNumber
  }

  export interface MultipleCallData {
    targets: Array<string>
    data: Array<string>
  }


export abstract class EthMarket implements MarketType {
    constructor(
        public marketAddress: string,
        public tokenAddress: string,
        public tokens: string[],
        public protocol: any
    ) {}

    async getReserves(_tokenAddress: string): Promise<BigNumber> {
        // Implementation
        return BigNumber.from(0);
    }

    async getTokensOut(_tokenIn: string, _tokenOut: string, _amountIn: BigNumber): Promise<BigNumber> {
        // Implementation
        return BigNumber.from(0);
    }

    async getPriceImpact(_tokenAddress: string, _tradeSize: BigNumber): Promise<BigNumber> {
        // Implementation
        return BigNumber.from(0);
    }

    async getTradingFee(_tokenAddress: string): Promise<BigNumber> {
        // Implementation
        return BigNumber.from(0);
    }

    async getBalance(_tokenAddress: string): Promise<BigNumber> {
        // Implementation
        return BigNumber.from(0);
    }

    async sellTokens(_tokenAddress: string, _volume: BigNumber, _recipient: string): Promise<string> {
        // Implementation
        return "";
    }

    async sellTokensToNextMarket(_tokenAddress: string, _volume: BigNumber, _nextMarket: MarketType): Promise<BuyCalls> {
        // Implementation
        return { targets: [], data: [] };
    }

    abstract receiveDirectly(tokenAddress: string): boolean;
}

export interface BuyCalls {
    targets: string[];
    data: string[];
}