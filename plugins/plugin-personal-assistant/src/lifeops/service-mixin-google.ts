import type {
  DisconnectLifeOpsGoogleConnectorRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
} from "../contracts/index.js";
import { GoogleDomain } from "./domains/google-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

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

/** @internal */
export function withGoogle<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsGoogleService> {
  const GoogleBase = Base;

  class LifeOpsGoogleServiceMixin extends GoogleBase {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly googleDomain = new GoogleDomain(this);

    public withGoogleGrantOperation<T>(
      _grant: LifeOpsConnectorGrant,
      operation: () => Promise<T>,
    ): Promise<T> {
      return this.googleDomain.withGoogleGrantOperation(_grant, operation);
    }

    public runManagedGoogleOperation<T>(
      _grant: LifeOpsConnectorGrant,
      _operation: () => Promise<T>,
    ): Promise<T> {
      return this.googleDomain.runManagedGoogleOperation(_grant, _operation);
    }

    public clearGoogleConnectorData(
      side?: LifeOpsConnectorSide,
    ): Promise<void> {
      return this.googleDomain.clearGoogleConnectorData(side);
    }

    public clearGoogleGrantData(grant: LifeOpsConnectorGrant): Promise<void> {
      return this.googleDomain.clearGoogleGrantData(grant);
    }

    public deleteCalendarReminderPlansForEvents(
      _eventIds: string[],
    ): Promise<void> {
      return this.googleDomain.deleteCalendarReminderPlansForEvents(_eventIds);
    }

    public setPreferredGoogleConnectorMode(
      _mode: LifeOpsConnectorMode | null,
      _side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsConnectorGrant | null> {
      return this.googleDomain.setPreferredGoogleConnectorMode(_mode, _side);
    }

    public requireGoogleCalendarGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      return this.googleDomain.requireGoogleCalendarGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
    }

    public requireGoogleCalendarWriteGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      return this.googleDomain.requireGoogleCalendarWriteGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
    }

    public requireGoogleGmailGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      return this.googleDomain.requireGoogleGmailGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
    }

    public requireGoogleGmailSendGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      return this.googleDomain.requireGoogleGmailSendGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
    }

    getGoogleConnectorStatus(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      return this.googleDomain.getGoogleConnectorStatus(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
    }

    getGoogleConnectorAccounts(
      requestUrl: URL,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus[]> {
      return this.googleDomain.getGoogleConnectorAccounts(
        requestUrl,
        requestedSide,
      );
    }

    selectGoogleConnectorMode(
      requestUrl: URL,
      preferredModeInput: LifeOpsConnectorMode | undefined,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      return this.googleDomain.selectGoogleConnectorMode(
        requestUrl,
        preferredModeInput,
        requestedSide,
      );
    }

    startGoogleConnector(
      request: StartLifeOpsGoogleConnectorRequest,
      requestUrl: URL,
    ): Promise<StartLifeOpsGoogleConnectorResponse> {
      return this.googleDomain.startGoogleConnector(request, requestUrl);
    }

    completeGoogleConnectorCallback(
      callbackUrl: URL,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      return this.googleDomain.completeGoogleConnectorCallback(callbackUrl);
    }

    disconnectGoogleConnector(
      request: DisconnectLifeOpsGoogleConnectorRequest,
      requestUrl: URL,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      return this.googleDomain.disconnectGoogleConnector(request, requestUrl);
    }
  }

  return LifeOpsGoogleServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsGoogleService
  >;
}
