import type { Plugin } from "@elizaos/core";
import { oauthConnectAction } from "./actions/oauth-connect";
import { oauthGetAction } from "./actions/oauth-get";
import { oauthListAction } from "./actions/oauth-list";
import { oauthRevokeAction } from "./actions/oauth-revoke";
import { userAuthStatusProvider } from "./providers/user-auth-status";

export {
  oauthConnectAction,
  oauthGetAction,
  oauthListAction,
  oauthRevokeAction,
  userAuthStatusProvider,
};

export const oauthPlugin: Plugin = {
  name: "eliza-cloud-oauth",
  description: "Cloud OAuth connection actions and user authentication context",
  actions: [oauthConnectAction, oauthGetAction, oauthListAction, oauthRevokeAction],
  providers: [userAuthStatusProvider],
  evaluators: [],
  services: [],
};

export default oauthPlugin;
