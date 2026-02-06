import type { Plugin } from "@elizaos/core";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "./actions";
import { MATTERMOST_SERVICE_NAME } from "./constants";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { MattermostService } from "./service";

const mattermostPlugin: Plugin = {
  name: MATTERMOST_SERVICE_NAME,
  description: "Mattermost client plugin for elizaOS",
  services: [MattermostService],
  actions: [sendMessageAction],
  providers: [chatStateProvider],
  tests: [],
};

export {
  MattermostService,
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  chatStateProvider,
  CHAT_STATE_PROVIDER,
  MATTERMOST_SERVICE_NAME,
};

export * from "./client";
export * from "./environment";
// Export types
export * from "./types";

export default mattermostPlugin;
