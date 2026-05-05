export type {
  AgentIdentity,
  AgentModelMetadata,
  AgentRegistrationFile,
  AgentRegistrationRef,
  AgentServiceEndpoint,
  ERC8004ClientConfig,
  MetadataEntry,
  RegistrationResult,
  SupportedChain,
  SupportedTrustMechanism,
} from "./erc8004.js";
export {
  buildDataURI,
  ERC8004Client,
  ERC8004IdentityRegistryAbi,
  formatAgentRegistry,
  KNOWN_REGISTRY_ADDRESSES,
  METADATA_KEYS,
  parseDataURI,
  REGISTRATION_FILE_TYPE,
  resolveAgentURI,
  validateRegistrationFile,
} from "./erc8004.js";
export type {
  AgentReputationSummary,
  FeedbackEntry,
  FeedbackFilters,
  GiveFeedbackParams,
  ReputationClientConfig,
  RespondToFeedbackParams,
} from "./reputation.js";
export { ReputationClient, ReputationRegistryAbi } from "./reputation.js";
export type {
  ParsedUAID,
  RegisterUAIDParams,
  UAIDProtocol,
  UAIDResolution,
  UAIDResolverConfig,
  UniversalAgentIdentity,
} from "./uaid.js";
// ─── UAID: Cross-Chain Identity Resolution ─────────────────────────────────
export { UAIDResolver } from "./uaid.js";
export type {
  RequestValidationParams,
  RespondToValidationParams,
  ValidationClientConfig,
  ValidationStatus,
  ValidationSummary,
} from "./validation.js";
export { ValidationClient, ValidationRegistryAbi } from "./validation.js";
