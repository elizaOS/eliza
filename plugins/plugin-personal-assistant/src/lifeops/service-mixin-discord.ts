import type { DiscordMessageSearchResult } from "@elizaos/plugin-discord/user-account-scraper";
import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordConnectorStatus,
  LifeOpsOwnerBrowserAccessSource,
} from "@elizaos/shared";
import {
  type DiscordConnectorVerification,
  DiscordDomain,
  type DiscordDomainDeps,
  type DiscordSendMessageResult,
} from "./domains/discord-service.js";
import type { BrowserBridgeService } from "./service-mixin-browser.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

type DiscordMixinDependencies = LifeOpsServiceBase &
  Pick<
    BrowserBridgeService,
    | "createBrowserSession"
    | "getBrowserSession"
    | "getBrowserSettings"
    | "getCurrentBrowserPage"
    | "listBrowserCompanions"
    | "listBrowserTabs"
  >;

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

/** @internal */
export function withDiscord<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsDiscordService> {
  const DiscordBase = Base as unknown as Constructor<DiscordMixinDependencies>;

  class LifeOpsDiscordServiceMixin extends DiscordBase {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly discordDomain = new DiscordDomain(this, {
      createBrowserSession: (...args) =>
        (this as unknown as DiscordDomainDeps).createBrowserSession(...args),
      getBrowserSession: (...args) =>
        (this as unknown as DiscordDomainDeps).getBrowserSession(...args),
      getBrowserSettings: (...args) =>
        (this as unknown as DiscordDomainDeps).getBrowserSettings(...args),
      getCurrentBrowserPage: (...args) =>
        (this as unknown as DiscordDomainDeps).getCurrentBrowserPage(...args),
      listBrowserCompanions: (...args) =>
        (this as unknown as DiscordDomainDeps).listBrowserCompanions(...args),
      listBrowserTabs: (...args) =>
        (this as unknown as DiscordDomainDeps).listBrowserTabs(...args),
      isBrowserPaused: (...args) =>
        (this as unknown as DiscordDomainDeps).isBrowserPaused(...args),
    });

    getDiscordConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      return this.discordDomain.getDiscordConnectorStatus(side);
    }

    authorizeDiscordConnector(
      side?: LifeOpsConnectorSide,
      source?: LifeOpsOwnerBrowserAccessSource,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      return this.discordDomain.authorizeDiscordConnector(side, source);
    }

    searchDiscordMessages(request: {
      side?: LifeOpsConnectorSide;
      query: string;
      channelId?: string;
      limit?: number;
    }): Promise<DiscordMessageSearchResult[]> {
      return this.discordDomain.searchDiscordMessages(request);
    }

    captureDiscordDeliveryStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<DiscordMessageSearchResult[]> {
      return this.discordDomain.captureDiscordDeliveryStatus(side);
    }

    sendDiscordMessage(request: {
      side?: LifeOpsConnectorSide;
      channelId?: string;
      text: string;
    }): Promise<DiscordSendMessageResult> {
      return this.discordDomain.sendDiscordMessage(request);
    }

    verifyDiscordConnector(request: {
      side?: LifeOpsConnectorSide;
      channelId?: string;
      sendMessage?: string;
    }): Promise<DiscordConnectorVerification> {
      return this.discordDomain.verifyDiscordConnector(request);
    }

    disconnectDiscord(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      return this.discordDomain.disconnectDiscord(side);
    }
  }

  return LifeOpsDiscordServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsDiscordService
  >;
}
