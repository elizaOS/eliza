/**
 * X (Twitter) write service mixin: declares the LifeOps X write service surface
 * and the mixin that composes the x domain's post/DM and connector-grant methods
 * onto the LifeOpsService base.
 */
import type {
  CreateLifeOpsXPostRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsXConnectorStatus,
  LifeOpsXDm,
  LifeOpsXPostResponse,
} from "../contracts/index.js";

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
