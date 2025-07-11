import { Service } from "@elizaos/core";
import { IBrowserService as IBrowserServiceV1 } from "@elizaos/core/v1";
import { CalldataWithDescription } from "./tx";
import { PendleActiveMarkets } from "src/api/market/pendle";

export interface ILevvaService extends Service {
  // known tokens
  formatToken(
    token: {
      symbol: string;
      name: string;
      address?: string;
      decimals: number;
      info?: Record<string, any>;
    },
    compact?: boolean
  ): string;
  getAvailableTokens(params: {
    chainId: number;
  }): Promise<
    {
      symbol: string;
      name: string;
      address?: string;
      decimals: number;
      info?: Record<string, any>;
    }[]
  >;

  // wallet assets
  getWalletAssets(params: {
    address: `0x${string}`;
    chainId: number;
  }): Promise<
    { symbol: string; balance: string; value: string; address?: string }[]
  >;
  formatWalletAssets(
    assets: {
      symbol: string;
      balance: string;
      value: string;
      address?: string;
    }[]
  ): string;

  // news aggregator
  getCryptoNews(limit?: number): Promise<
    {
      id: string;
      title: string;
      description: string;
      link: string;
      createdAt: Date;
    }[]
  >;

  // market data
  getPendleMarkets(params: { chainId: number }): Promise<PendleActiveMarkets>;

  // cached calldata
  createCalldata(calls: CalldataWithDescription[]): Promise<`0x${string}`>;
  getCalldata(hash: `0x${string}`): Promise<CalldataWithDescription[]>;
}

// service defined in @elizaos/plugin-browser
export interface IBrowserService
  extends Service,
    Pick<IBrowserServiceV1, "getPageContent"> {}
