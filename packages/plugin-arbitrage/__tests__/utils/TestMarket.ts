import { EthMarket } from '../../src/core/EthMarket';
import { BigNumber } from '@ethersproject/bignumber';

export class TestMarket extends EthMarket {
    constructor(address: string, tokenAddress: string) {
        super(address, tokenAddress, [tokenAddress], {});
    }

    receiveDirectly(tokenAddress: string): boolean {
        return true;
    }

    async getReserves(tokenAddress: string): Promise<BigNumber> {
        return BigNumber.from('1000000');
    }

    async getTokensOut(tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<BigNumber> {
        return amountIn.mul(95).div(100);  // 5% slippage
    }

    async sellTokens(tokenAddress: string, volume: BigNumber, recipient: string): Promise<string> {
        return '0xmocktx';
    }

    async sellTokensToNextMarket(tokenAddress: string, volume: BigNumber, nextMarket: EthMarket): Promise<{ targets: string[], data: string[] }> {
        return {
            targets: ['0xmocktarget'],
            data: ['0xmockdata']
        };
    }
}
