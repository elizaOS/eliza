import { Service } from "@elizaos/core";
import { IBrowserService as IBrowserServiceV1 } from "@elizaos/core/v1";
import { CalldataWithDescription } from "./tx";
import { PendleActiveMarkets } from "src/api/market/pendle";

export interface ILevvaService extends Service {
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

  // cached calldata
  createCalldata(calls: CalldataWithDescription[]): Promise<`0x${string}`>;
  getCalldata(hash: `0x${string}`): Promise<CalldataWithDescription[]>;
}

// service defined in @elizaos/plugin-browser
export interface IBrowserService
  extends Service,
    Pick<IBrowserServiceV1, "getPageContent"> {}
