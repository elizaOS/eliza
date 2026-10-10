import {
  attachVoiceWsHandler as attachHostVoiceWsHandler,
  type VoiceWsHandlerDeps as HostVoiceWsHandlerDeps,
  type ServerWebSocketLike,
} from "@elizaos/host/voice/ws-handler";
import { verifyVoiceSessionToken } from "./jwt";

export type {
  ServerWebSocketLike,
  VoiceSessionDownlink,
  VoiceSessionLike,
} from "@elizaos/host/voice/ws-handler";
export type VoiceWsHandlerDeps = Omit<HostVoiceWsHandlerDeps, "verifyToken"> & {
  verifyToken?: typeof verifyVoiceSessionToken;
};
/** Cloud owns JWT authentication; the transport is shared with other hosts. */
export function attachVoiceWsHandler(socket: ServerWebSocketLike, deps: VoiceWsHandlerDeps): void {
  attachHostVoiceWsHandler(socket, {
    ...deps,
    verifyToken: deps.verifyToken ?? verifyVoiceSessionToken,
  });
}
