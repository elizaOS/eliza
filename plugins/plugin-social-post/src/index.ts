/**
 * @elizaos/plugin-social-post
 *
 * One generic POST_TO_SOCIAL action that dispatches to a platform-specific
 * service via runtime.getService lookup. Mirrors the SEND_MESSAGE design
 * (one canonical entry point, platform connector indirection) for public
 * social posts.
 *
 * The plugin has no hard dependency on platform plugins. If a target
 * platform's service is not registered, the action returns a clear error.
 */
import type { Plugin } from "@elizaos/core";
import { postToSocialAction } from "./actions/post-to-social.js";

export const socialPostPlugin: Plugin = {
	name: "@elizaos/plugin-social-post",
	description:
		"Generic POST_TO_SOCIAL action that publishes to X, Bluesky, Farcaster, or Nostr through their registered services.",
	actions: [postToSocialAction],
};

export default socialPostPlugin;
export { postToSocialAction };
