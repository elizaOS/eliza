/**
 * `CloudSetupSessionService` interface: the five operations
 * (startSession / sendMessage / getStatus / finalizeHandoff / cancel) a guided
 * cloud-setup backend must implement. `MockCloudSetupSessionService` is the
 * reference implementation; production backends implement this contract.
 */

import type {
  ContainerHandoffEnvelope,
  SetupExtractedFact,
  SetupSessionEnvelope,
  SetupSessionId,
  SetupTranscriptMessage,
  TenantId,
} from "./types.js";

export interface StartSessionInput {
  tenantId: TenantId;
}

export interface SendMessageInput {
  sessionId: SetupSessionId;
  message: string;
}

export interface SendMessageResult {
  replies: SetupTranscriptMessage[];
  facts: SetupExtractedFact[];
}

export interface FinalizeHandoffInput {
  sessionId: SetupSessionId;
  containerId: string;
}

export interface CloudSetupSessionService {
  startSession(input: StartSessionInput): Promise<SetupSessionEnvelope>;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  getStatus(sessionId: SetupSessionId): Promise<SetupSessionEnvelope>;
  finalizeHandoff(
    input: FinalizeHandoffInput,
  ): Promise<ContainerHandoffEnvelope>;
  cancel(sessionId: SetupSessionId): Promise<void>;
}
