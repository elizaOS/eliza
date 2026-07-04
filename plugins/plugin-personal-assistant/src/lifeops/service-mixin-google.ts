/**
 * Google connector service mixin: declares the LifeOps Google connector service
 * surface and the `withGoogle` mixin that composes the Google domain's
 * connect/disconnect and status methods onto the LifeOpsService base.
 */
import type {
  DisconnectLifeOpsGoogleConnectorRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
} from "../contracts/index.js";

export interface LifeOpsGoogleService {
  getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  getGoogleConnectorAccounts(
    requestUrl: URL,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]>;
  selectGoogleConnectorMode(
    requestUrl: URL,
    preferredModeInput: LifeOpsConnectorMode | undefined,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  startGoogleConnector(
    request: StartLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsGoogleConnectorResponse>;
  completeGoogleConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  disconnectGoogleConnector(
    request: DisconnectLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus>;
}
