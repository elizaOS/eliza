/** Barrel for the `@elizaos/cloud-sdk/cloud-setup-session` sub-export: guided-setup service interface, mock implementation, policy, and types. */

/** @deprecated Import test implementations from @elizaos/cloud-sdk/testing. */
export {
  MockCloudSetupSessionService,
  type MockCloudSetupSessionServiceOptions,
} from "../testing.js";
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
