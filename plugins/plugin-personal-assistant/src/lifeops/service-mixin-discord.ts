import type { DiscordMessageSearchResult } from "@elizaos/plugin-discord/user-account-scraper";
import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordConnectorStatus,
  LifeOpsOwnerBrowserAccessSource,
} from "@elizaos/shared";
import type {
  DiscordConnectorVerification,
  DiscordSendMessageResult,
} from "./domains/discord-service.js";

export interface LifeOpsDiscordService {
  getDiscordConnectorStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus>;
  authorizeDiscordConnector(
    side?: LifeOpsConnectorSide,
    source?: LifeOpsOwnerBrowserAccessSource,
  ): Promise<LifeOpsDiscordConnectorStatus>;
  searchDiscordMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    channelId?: string;
    limit?: number;
  }): Promise<DiscordMessageSearchResult[]>;
  captureDiscordDeliveryStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<DiscordMessageSearchResult[]>;
  sendDiscordMessage(request: {
    side?: LifeOpsConnectorSide;
    channelId?: string;
    text: string;
  }): Promise<DiscordSendMessageResult>;
  verifyDiscordConnector(request: {
    side?: LifeOpsConnectorSide;
    channelId?: string;
    sendMessage?: string;
  }): Promise<DiscordConnectorVerification>;
  disconnectDiscord(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus>;
}
