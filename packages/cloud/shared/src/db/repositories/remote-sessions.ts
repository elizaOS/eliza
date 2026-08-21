/** Exposes the production remote-session repository at its stable import path. */

import { dbWrite } from "../helpers";
import { RemoteSessionsRepository } from "./remote-sessions-store";

export type {
  NewRemoteSession,
  RemoteSession,
  RemoteSessionStatus,
} from "../schemas/remote-sessions";
export {
  RemoteSessionsRepository,
  type RevokeRemoteSessionResult,
} from "./remote-sessions-store";

export const remoteSessionsRepository = new RemoteSessionsRepository(dbWrite);
