import { coinbaseMassPaymentsPlugin } from "./plugins/massPayments";
import { coinbaseCommercePlugin } from "./plugins/commerce";
import { tradePlugin } from "./plugins/trade";
import { tokenContractPlugin } from "./plugins/tokenContract";
import { webhookPlugin } from "./plugins/webhooks";
import { advancedTradePlugin } from "./plugins/advancedTrade";
import { bridgePlugin } from "./plugins/bridging";

export const plugins = {
    coinbaseMassPaymentsPlugin,
    coinbaseCommercePlugin,
    tradePlugin,
    tokenContractPlugin,
    webhookPlugin,
    advancedTradePlugin,
    bridgePlugin,
};

export * from "./plugins/massPayments";
export * from "./plugins/commerce";
export * from "./plugins/trade";
export * from "./plugins/tokenContract";
export * from "./plugins/webhooks";
export * from "./plugins/advancedTrade";
export * from "./plugins/bridging";
