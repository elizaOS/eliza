/**
 * `REMOTE_DESKTOP` umbrella action — re-export shim.
 *
 * The remote-desktop domain (the REMOTE_DESKTOP start/status/end/list/revoke
 * action, the backend-detection engine, and the RemoteSessionService control
 * plane) moved to `@elizaos/plugin-remote-desktop`, which now registers the
 * action. PA loads that plugin via `ensureLifeOpsRemoteDesktopPluginRegistered`.
 * This shim re-exports the moved public symbols so existing PA imports (and
 * tests) keep resolving.
 */

export {
  REMOTE_DESKTOP_ACTION_NAME,
  remoteDesktopAction,
  type RemoteDesktopActionParams,
  type RemoteDesktopSubaction,
} from "@elizaos/plugin-remote-desktop";

export { remoteDesktopAction as default } from "@elizaos/plugin-remote-desktop";
