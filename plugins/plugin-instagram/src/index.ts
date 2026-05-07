import type { Plugin } from "@elizaos/core";
import { instagramReplyAction } from "./actions";
import { INSTAGRAM_SERVICE_NAME } from "./constants";
import { InstagramN8nCredentialProvider } from "./n8n-credential-provider";
import { userStateProvider } from "./providers";
import { InstagramService } from "./service";

const instagramPlugin: Plugin = {
  name: INSTAGRAM_SERVICE_NAME,
  description: "Instagram client plugin for elizaOS",
  actions: [instagramReplyAction],
  providers: [userStateProvider],
  services: [InstagramService, InstagramN8nCredentialProvider],
};

export { instagramReplyAction } from "./actions";
export * from "./constants";
export { userStateProvider } from "./providers";
export * from "./types";
export { InstagramService };
export default instagramPlugin;
