import type { Plugin } from "@elizaos/core";
import { postCommentAction, sendDmAction } from "./actions";
import { INSTAGRAM_SERVICE_NAME } from "./constants";
import { userStateProvider } from "./providers";
import { InstagramService } from "./service";

const instagramPlugin: Plugin = {
  name: INSTAGRAM_SERVICE_NAME,
  description: "Instagram client plugin for elizaOS",
  actions: [sendDmAction, postCommentAction],
  providers: [userStateProvider],
  services: [InstagramService],
};

export { InstagramService };
export { postCommentAction, sendDmAction } from "./actions";
export * from "./constants";
export { userStateProvider } from "./providers";
export * from "./types";
export default instagramPlugin;
