/**
 * Smart Contract Type Definitions
 *
 * Complete TypeScript interfaces for blockchain contract interactions.
 * These types provide type safety when interacting with Polyagent's smart contracts.
 *
 * @packageDocumentation
 */

/**
 * Interface for Identity Registry contract methods.
 *
 * Provides type-safe access to ERC-8004 Identity Registry contract functions.
 */
export interface IdentityRegistryContract {
  /** Get the token ID for a registered agent address */
  getTokenId(address: string): Promise<bigint>;
  /** Get the owner address of a token ID */
  ownerOf(tokenId: number): Promise<string>;
  /** Get the complete profile for an agent token */
  getAgentProfile(tokenId: number): Promise<AgentProfileResult>;
  /** Check if an address is registered as an agent */
  isRegistered(address: string): Promise<boolean>;
  /** Get all active agent token IDs */
  getAllActiveAgents(): Promise<bigint[]>;
  /** Check if an endpoint is currently active */
  isEndpointActive(endpoint: string): Promise<boolean>;
  /** Get agent token IDs by capability hash */
  getAgentsByCapability(capabilityHash: string): Promise<bigint[]>;
}

/**
 * Interface for Reputation System contract methods.
 *
 * Provides type-safe access to ERC-8004 Reputation System contract functions.
 */
export interface ReputationSystemContract {
  /** Get reputation metrics for an agent token */
  getReputation(tokenId: number): Promise<ReputationResult>;
  /** Get the total number of feedback entries for an agent */
  getFeedbackCount(tokenId: number): Promise<bigint>;
  /** Get a specific feedback entry by index */
  getFeedback(tokenId: number, index: number): Promise<FeedbackResult>;
  /** Get agent token IDs with minimum reputation score */
  getAgentsByMinScore(minScore: number): Promise<bigint[]>;
}

/**
 * Agent profile data returned from Identity Registry contract calls.
 */
export interface AgentProfileResult {
  /** Agent display name */
  name: string;
  /** Agent service endpoint URL */
  endpoint: string;
  /** Hash of agent capabilities */
  capabilitiesHash: string;
  /** Block timestamp when agent was registered */
  registeredAt: bigint;
  /** Whether the agent is currently active */
  isActive: boolean;
  /** Additional metadata JSON string */
  metadata: string;
}

/**
 * Reputation metrics returned from Reputation System contract calls.
 *
 * @remarks This is a tuple type matching the Solidity return type structure.
 */
export type ReputationResult = [
  /** Total number of bets placed by the agent */
  totalBets: bigint,
  /** Number of winning bets */
  winningBets: bigint,
  /** Total volume of all bets */
  totalVolume: bigint,
  /** Net profit/loss across all bets */
  profitLoss: bigint,
  /** Calculated accuracy score */
  accuracyScore: bigint,
  /** Calculated trust score */
  trustScore: bigint,
  /** Whether the agent is currently banned */
  isBanned: boolean,
];

/**
 * Feedback data returned from Reputation System contract calls.
 */
export interface FeedbackResult {
  /** Address of the user who submitted the feedback */
  from: string;
  /** Rating value (int8 from contract, mapped to number) */
  rating: number;
  /** Feedback comment text */
  comment: string;
  /** Block timestamp when feedback was submitted */
  timestamp: bigint;
}

/**
 * Contract addresses for a deployment environment.
 *
 * Contains addresses for all deployed Polyagent smart contracts on a specific network.
 *
 * Architecture:
 * - Diamond: Upgradeable proxy with facets for prediction markets, perps, etc.
 * - PolyagentGameOracle: The game IS the prediction oracle (IPredictionOracle)
 * - GameOracleFacet: Bridges oracle outcomes to Diamond markets
 */
export interface DeploymentContracts {
  /** Diamond proxy contract address */
  diamond: string;
  /** DiamondCut facet address */
  diamondCutFacet: string;
  /** DiamondLoupe facet address */
  diamondLoupeFacet: string;
  /** PredictionMarket facet address */
  predictionMarketFacet: string;
  /** Oracle facet address (Chainlink/Mock) */
  oracleFacet: string;
  /** GameOracle facet address (bridges PolyagentGameOracle to Diamond) */
  gameOracleFacet?: string;
  /** LiquidityPool facet address */
  liquidityPoolFacet: string;
  /** PerpetualMarket facet address */
  perpetualMarketFacet: string;
  /** ReferralSystem facet address */
  referralSystemFacet: string;
  /** PriceStorage facet address */
  priceStorageFacet: string;
  /** ERC-8004 Identity Registry address */
  identityRegistry: string;
  /** ERC-8004 Reputation System address */
  reputationSystem: string;
  /** Polyagent Game Oracle address - THE GAME IS THE PREDICTION ORACLE */
  polyagentOracle?: string;
  /** Ban Manager address (optional) */
  banManager?: string;
  /** Chainlink Oracle mock address (testnet only) */
  chainlinkOracle?: string;
  /** Mock Oracle address (testnet only) */
  mockOracle?: string;
}

/**
 * Complete deployment information for a network.
 *
 * Contains all contract addresses, deployment metadata, and network configuration.
 */
export interface Deployment {
  /** Network name identifier */
  network: string;
  /** Chain ID for the network */
  chainId: number;
  /** Contract addresses for the deployment */
  contracts: DeploymentContracts;
  /** Address that deployed the contracts */
  deployer: string;
  /** ISO timestamp of deployment */
  timestamp: string;
  /** Block number at deployment */
  blockNumber: number;
}

/**
 * Event data emitted when an agent is registered in the Identity Registry.
 */
export interface AgentRegisteredEvent {
  /** Token ID assigned to the agent */
  tokenId: bigint;
  /** Address that owns the agent token */
  owner: string;
  /** Agent display name */
  name: string;
  /** Agent service endpoint URL */
  endpoint: string;
}

/**
 * Event data emitted when an agent's reputation scores are updated.
 */
export interface ReputationUpdatedEvent {
  /** Agent token ID */
  tokenId: bigint;
  /** Updated accuracy score */
  accuracyScore: bigint;
  /** Updated trust score */
  trustScore: bigint;
}

/**
 * Event data emitted when feedback is submitted for an agent.
 */
export interface FeedbackSubmittedEvent {
  /** Agent token ID receiving feedback */
  tokenId: bigint;
  /** Address submitting the feedback */
  from: string;
  /** Rating value (typically -1 to 1) */
  rating: number;
}
