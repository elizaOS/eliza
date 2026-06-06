import { remoteDesktopPlugin } from "./plugin.js";

export { remoteDesktopPlugin } from "./plugin.js";
export default remoteDesktopPlugin;

export {
  REMOTE_DESKTOP_ACTION_NAME,
  remoteDesktopAction,
} from "./actions/remote-desktop.js";

export type {
  DataPlaneUnavailableReason,
  RemoteDesktopActionParams,
  RemoteDesktopBackend,
  RemoteDesktopConfig,
  RemoteDesktopSession,
  RemoteDesktopSessionStatus,
  RemoteDesktopSubaction,
  RemoteSession,
  RemoteSessionStatus,
  StartSessionParams,
  StartSessionResult,
} from "./types.js";
