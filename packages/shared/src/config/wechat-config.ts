// Back-compat re-export. The canonical home for `isWechatConfigured` is
// @elizaos/core/connectors/connector-config so plugin packages can import
// it without depending on @elizaos/shared.
export { isWechatConfigured } from "@elizaos/core";

export const WECHAT_PLUGIN_PACKAGE = "@elizaos/plugin-wechat" as const;
