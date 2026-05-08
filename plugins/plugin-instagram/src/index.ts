import type { Plugin } from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME } from "./constants";
import { userStateProvider } from "./providers";
import { InstagramService } from "./service";

const instagramPlugin: Plugin = {
  name: INSTAGRAM_SERVICE_NAME,
  description: "Instagram client plugin for elizaOS",
  actions: [],
  providers: [userStateProvider],
  services: [InstagramService],
};

export * from "./accounts";
export * from "./constants";
export { userStateProvider } from "./providers";
export * from "./types";
export { InstagramService };
export default instagramPlugin;
