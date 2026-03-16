import type { Plugin } from "@elizaos/core";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "./actions";
import { ZALO_SERVICE_NAME } from "./constants";
import {
  buildZaloSettings,
  validateZaloConfig,
  type ZaloConfig,
} from "./environment";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { ZaloService } from "./service";
import {
  type ZaloBotProbe,
  type ZaloContent,
  ZaloEventTypes,
  type ZaloMessage,
  type ZaloOAInfo,
  type ZaloSettings,
} from "./types";

/**
 * Zalo plugin for elizaOS
 */
const zaloPlugin: Plugin = {
  name: ZALO_SERVICE_NAME,
  description:
    "Zalo Official Account Bot API integration with webhook and polling support",
  services: [ZaloService],
  actions: [sendMessageAction],
  providers: [chatStateProvider],
};

export {
  // Plugin
  zaloPlugin,
  // Service
  ZaloService,
  ZALO_SERVICE_NAME,
  // Actions
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  // Providers
  chatStateProvider,
  CHAT_STATE_PROVIDER,
  // Types
  ZaloEventTypes,
  type ZaloBotProbe,
  type ZaloContent,
  type ZaloMessage,
  type ZaloOAInfo,
  type ZaloSettings,
  type ZaloConfig,
  // Config utilities
  buildZaloSettings,
  validateZaloConfig,
};

export default zaloPlugin;
