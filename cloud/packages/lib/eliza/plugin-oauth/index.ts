import type { Plugin } from "@elizaos/core";
import { oauthGetAction } from "./actions/oauth-get";
import { oauthListAction } from "./actions/oauth-list";
import { userAuthStatusProvider } from "./providers/user-auth-status";

export { oauthGetAction, oauthListAction, userAuthStatusProvider };

export const oauthPlugin: Plugin = {
  name: "eliza-cloud-oauth",
  description: "Cloud OAuth connection actions and user authentication context",
  actions: [oauthGetAction, oauthListAction],
  providers: [userAuthStatusProvider],
  evaluators: [],
  services: [],
};

export default oauthPlugin;
