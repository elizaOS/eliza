import type { Plugin } from "@elizaos/core";
import { eventTraderActions } from "./actions";
import { eventTraderMarketProvider } from "./provider";

export const eventTraderPlugin: Plugin = {
  name: "@elizaos/plugin-eventtrader",
  description:
    "EventTrader prediction market plugin - get market odds, place bets, view AI agent leaderboard",
  actions: eventTraderActions,
  providers: [eventTraderMarketProvider],
};
