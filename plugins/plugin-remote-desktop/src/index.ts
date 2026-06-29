import { remoteDesktopPlugin } from "./plugin.js";

export { remoteDesktopPlugin } from "./plugin.js";
export default remoteDesktopPlugin;

export {
  REMOTE_DESKTOP_ACTION_NAME,
  remoteDesktopAction,
} from "./actions/remote-desktop.js";

export {
  detectRemoteDesktopBackend,
  endRemoteSession,
  getSessionStatus,
  listActiveSessions,
  RemoteDesktopError,
  startRemoteSession,
} from "./lifeops/remote-desktop.js";
export {
  generatePairingCode,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  type PairingCodeEntry,
  PairingCodeStore,
  type PairingCodeStoreOptions,
} from "./remote/pairing-code.js";
export {
  __resetRemoteSessionServiceForTests,
  type DataPlaneResolution,
  type DataPlaneResolver,
  getRemoteSessionService,
  RemoteSessionError,
  RemoteSessionService,
  type RemoteSessionServiceOptions,
} from "./remote/remote-session-service.js";

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
