/**
 * `REMOTE_DESKTOP` umbrella action — re-export shim.
 *
 * The remote-desktop domain (the REMOTE_DESKTOP start/status/end/list/revoke
 * action, the backend-detection engine, and the RemoteSessionService control
 * plane) lives in `@elizaos/plugin-remote-desktop`, which registers the
 * action. PA loads that plugin via `ensureLifeOpsRemoteDesktopPluginRegistered`;
 * this shim re-exports its public symbols so PA imports and tests keep
 * resolving.
 */

export {
  REMOTE_DESKTOP_ACTION_NAME,
  type RemoteDesktopActionParams,
  type RemoteDesktopSubaction,
  remoteDesktopAction,
  remoteDesktopAction as default,
} from "@elizaos/plugin-remote-desktop";
