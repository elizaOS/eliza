/**
 * Plugin OAuth
 *
 * OAuth toolkit for ElizaOS agents.
 * Enables users to connect/manage OAuth platforms (Google) through chat.
 *
 * Actions are registered via cloud-bootstrap plugin.
 */

export { oauthConnectAction } from "./actions/oauth-connect";
export { oauthListAction } from "./actions/oauth-list";
export { oauthGetAction } from "./actions/oauth-get";
export { oauthRevokeAction } from "./actions/oauth-revoke";
export { userAuthStatusProvider } from "./providers/user-auth-status";
