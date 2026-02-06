import type { Plugin } from "@elizaos/core";
import {
  checkStatusAction,
  CHECK_STATUS_ACTION,
  getProfileAction,
  GET_PROFILE_ACTION,
  listFriendsAction,
  LIST_FRIENDS_ACTION,
  listGroupsAction,
  LIST_GROUPS_ACTION,
  sendImageAction,
  SEND_IMAGE_ACTION,
  sendLinkAction,
  SEND_LINK_ACTION,
  sendMessageAction,
  SEND_MESSAGE_ACTION,
} from "./actions";
import { ZALOUSER_SERVICE_NAME } from "./constants";
import {
  buildZaloUserSettings,
  validateZaloUserConfig,
  type ZaloUserSettings,
} from "./environment";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { ZaloUserService } from "./service";
import {
  type SendMediaParams,
  type SendMessageParams,
  type SendMessageResult,
  type ZaloChat,
  type ZaloFriend,
  type ZaloGroup,
  type ZaloMessage,
  type ZaloUser,
  type ZaloUserContent,
  ZaloUserEventTypes,
  type ZaloUserInfo,
  type ZaloUserProbe,
} from "./types";

const zaloUserPlugin: Plugin = {
  name: ZALOUSER_SERVICE_NAME,
  description:
    "Zalo personal account integration via zca-cli — QR login, messaging, images, links, friends, groups, profile, and status",
  services: [ZaloUserService],
  actions: [
    sendMessageAction,
    sendImageAction,
    sendLinkAction,
    listFriendsAction,
    listGroupsAction,
    getProfileAction,
    checkStatusAction,
  ],
  providers: [chatStateProvider],
};

export {
  // Service
  ZaloUserService,
  // Actions
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  sendImageAction,
  SEND_IMAGE_ACTION,
  sendLinkAction,
  SEND_LINK_ACTION,
  listFriendsAction,
  LIST_FRIENDS_ACTION,
  listGroupsAction,
  LIST_GROUPS_ACTION,
  getProfileAction,
  GET_PROFILE_ACTION,
  checkStatusAction,
  CHECK_STATUS_ACTION,
  // Providers
  chatStateProvider,
  CHAT_STATE_PROVIDER,
  // Types
  ZaloUserEventTypes,
  type SendMessageParams,
  type SendMessageResult,
  type SendMediaParams,
  type ZaloChat,
  type ZaloFriend,
  type ZaloGroup,
  type ZaloMessage,
  type ZaloUser,
  type ZaloUserContent,
  type ZaloUserInfo,
  type ZaloUserProbe,
  type ZaloUserSettings,
  // Config utilities
  buildZaloUserSettings,
  validateZaloUserConfig,
  // Constants
  ZALOUSER_SERVICE_NAME,
};

export default zaloUserPlugin;
