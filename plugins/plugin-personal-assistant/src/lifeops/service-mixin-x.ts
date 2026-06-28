import type {
  CreateLifeOpsXPostRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsXConnectorStatus,
  LifeOpsXDm,
  LifeOpsXPostResponse,
} from "../contracts/index.js";
import { XDomain, type XDomainDeps } from "./domains/x-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export interface LifeOpsXService {
  resolveXGrant(
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    requestedAccountId?: string | null,
  ): Promise<LifeOpsConnectorGrant | null>;
  getXConnectorStatus(
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    requestedAccountId?: string | null,
  ): Promise<LifeOpsXConnectorStatus>;
  createXPost(
    request: CreateLifeOpsXPostRequest,
  ): Promise<LifeOpsXPostResponse>;
  getXDmDigest(opts?: {
    accountId?: string;
    limit?: number;
    conversationId?: string;
  }): Promise<{
    generatedAt: string;
    conversationId: string | null;
    unreadCount: number;
    readCount: number;
    repliedCount: number;
    recent: LifeOpsXDm[];
  }>;
  curateXDms(request: {
    messageIds?: string[];
    conversationId?: string;
    markRead?: boolean;
    markReplied?: boolean;
  }): Promise<{ curated: number }>;
  sendXDirectMessage(request: {
    participantId: string;
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
  }): Promise<{ ok: boolean; status: number | null; error?: string }>;
  sendXConversationMessage(request: {
    conversationId: string;
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
  }): Promise<{ ok: boolean; status: number | null; error?: string }>;
  createXDirectMessageGroup(request: {
    participantIds: string[];
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
  }): Promise<{
    ok: boolean;
    status: number | null;
    conversationId: string | null;
    error?: string;
  }>;
}

export function withX<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsXService> {
  class LifeOpsXServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly xDomain = new XDomain(this, {
      recordXPostAudit: (...args) => this.recordXPostAudit(...args),
      resolvePrimaryChannelPolicy: (...args) =>
        (this as unknown as XDomainDeps).resolvePrimaryChannelPolicy(...args),
    });

    resolveXGrant(
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      requestedAccountId?: string | null,
    ): Promise<LifeOpsConnectorGrant | null> {
      return this.xDomain.resolveXGrant(
        requestedMode,
        requestedSide,
        requestedAccountId,
      );
    }

    getXConnectorStatus(
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      requestedAccountId?: string | null,
    ): Promise<LifeOpsXConnectorStatus> {
      return this.xDomain.getXConnectorStatus(
        requestedMode,
        requestedSide,
        requestedAccountId,
      );
    }

    createXPost(
      request: CreateLifeOpsXPostRequest,
    ): Promise<LifeOpsXPostResponse> {
      return this.xDomain.createXPost(request);
    }

    getXDmDigest(opts?: {
      accountId?: string;
      limit?: number;
      conversationId?: string;
    }): Promise<{
      generatedAt: string;
      conversationId: string | null;
      unreadCount: number;
      readCount: number;
      repliedCount: number;
      recent: LifeOpsXDm[];
    }> {
      return this.xDomain.getXDmDigest(opts);
    }

    curateXDms(request: {
      messageIds?: string[];
      conversationId?: string;
      markRead?: boolean;
      markReplied?: boolean;
    }): Promise<{ curated: number }> {
      return this.xDomain.curateXDms(request);
    }

    sendXDirectMessage(request: {
      participantId: string;
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      accountId?: string;
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      return this.xDomain.sendXDirectMessage(request);
    }

    sendXConversationMessage(request: {
      conversationId: string;
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      accountId?: string;
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      return this.xDomain.sendXConversationMessage(request);
    }

    createXDirectMessageGroup(request: {
      participantIds: string[];
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      accountId?: string;
    }): Promise<{
      ok: boolean;
      status: number | null;
      conversationId: string | null;
      error?: string;
    }> {
      return this.xDomain.createXDirectMessageGroup(request);
    }
  }

  return LifeOpsXServiceMixin as unknown as MixinClass<TBase, LifeOpsXService>;
}
