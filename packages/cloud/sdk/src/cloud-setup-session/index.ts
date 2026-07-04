/** Barrel for the `@elizaos/cloud-sdk/cloud-setup-session` sub-export: guided-setup service interface, mock implementation, policy, and types. */

export {
  MockCloudSetupSessionService,
  type MockCloudSetupSessionServiceOptions,
} from "./mock-service.js";
export { DEFAULT_SETUP_POLICY, isActionAllowed } from "./policy.js";
export type {
  CloudSetupSessionService,
  FinalizeHandoffInput,
  SendMessageInput,
  SendMessageResult,
  StartSessionInput,
} from "./service-interface.js";
export type {
  ContainerHandoffEnvelope,
  ContainerStatus,
  SetupActionPolicy,
  SetupExtractedFact,
  SetupSessionEnvelope,
  SetupSessionId,
  SetupTranscriptMessage,
  TenantId,
} from "./types.js";
