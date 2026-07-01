import type { Plugin } from "@elizaos/core";
import { oauthAction } from "./actions/oauth";
import { userAuthStatusProvider } from "./providers/user-auth-status";

export { oauthAction, userAuthStatusProvider };

export const oauthPlugin: Plugin = {
  name: "eliza-cloud-oauth",
  description: "Cloud OAuth connection actions and user authentication context",
  actions: [oauthAction],
  providers: [userAuthStatusProvider],
  evaluators: [],
  services: [],
};

export default oauthPlugin;
