import type { Plugin } from "@elizaos/core";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "./actions";
import { NEXTCLOUD_TALK_SERVICE_NAME } from "./constants";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { NextcloudTalkService } from "./service";

const nextcloudTalkPlugin: Plugin = {
  name: NEXTCLOUD_TALK_SERVICE_NAME,
  description: "Nextcloud Talk client plugin with webhook bot integration",
  services: [NextcloudTalkService],
  actions: [sendMessageAction],
  providers: [chatStateProvider],
};

export {
  NextcloudTalkService,
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  chatStateProvider,
  CHAT_STATE_PROVIDER,
};
export * from "./client";
export * from "./constants";
export * from "./environment";
export * from "./types";
export default nextcloudTalkPlugin;
