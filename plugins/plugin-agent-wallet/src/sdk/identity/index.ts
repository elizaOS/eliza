export {
  ERC8004Client, ERC8004IdentityRegistryAbi, METADATA_KEYS,
  REGISTRATION_FILE_TYPE, KNOWN_REGISTRY_ADDRESSES,
  buildDataURI, parseDataURI, resolveAgentURI, validateRegistrationFile, formatAgentRegistry,
} from './erc8004.js';
export type {
  AgentServiceEndpoint, SupportedTrustMechanism, AgentRegistrationRef,
  AgentRegistrationFile, AgentModelMetadata, AgentIdentity,
  MetadataEntry, ERC8004ClientConfig, RegistrationResult, SupportedChain,
} from './erc8004.js';

export { ReputationClient, ReputationRegistryAbi } from './reputation.js';
export type {
  ReputationClientConfig, GiveFeedbackParams, FeedbackEntry,
  AgentReputationSummary, FeedbackFilters, RespondToFeedbackParams,
} from './reputation.js';

export { ValidationClient, ValidationRegistryAbi } from './validation.js';
export type {
  ValidationClientConfig, RequestValidationParams, RespondToValidationParams,
  ValidationStatus, ValidationSummary,
} from './validation.js';

// ─── UAID: Cross-Chain Identity Resolution ─────────────────────────────────
export { UAIDResolver } from './uaid.js';
export type {
  UAIDProtocol, ParsedUAID, UAIDResolution, UniversalAgentIdentity,
  UAIDResolverConfig, RegisterUAIDParams,
} from './uaid.js';
