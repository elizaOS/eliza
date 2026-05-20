/**
 * A2A Server Type Definitions
 *
 * Types for A2A server configuration and dependencies
 */

import type {
  JsonValue,
  PaymentVerificationParams,
  PaymentVerificationResult,
} from "@feed/shared";
import type { AgentCapabilities, AgentProfile } from "./a2a";

/**
 * Agent registry entry
 */
export interface AgentRegistryEntry {
  agentId: string;
  [key: string]: JsonValue;
}

/**
 * Registry client interface
 * Supports both simple registry operations and blockchain-based registry
 * Named IRegistryClient to distinguish from the RegistryClient class
 */
export interface IRegistryClient {
  // Simple registry operations
  register(agentId: string, data: Record<string, JsonValue>): Promise<void>;
  unregister(agentId: string): Promise<void>;
  getAgents(): Promise<AgentRegistryEntry[]>;
  getAgent(agentId: string): Promise<AgentRegistryEntry | null>;

  // Blockchain-based registry operations (optional)
  discoverAgents?(filters?: {
    strategies?: string[];
    minReputation?: number;
    markets?: string[];
  }): Promise<AgentProfile[]>;
  getAgentProfile?(tokenId: number): Promise<AgentProfile | null>;
  verifyAgent?(address: string, tokenId: number): Promise<boolean>;
}

/**
 * Payment request result (matches PaymentRequest from a2a/types)
 */
export interface PaymentRequestResult {
  requestId: string;
  from: string;
  to: string;
  amount: string;
  service: string;
  metadata?: Record<string, JsonValue>;
  expiresAt: number;
}

/**
 * X402 payment manager interface
 * Named IX402Manager to distinguish from the X402Manager class
 */
export interface IX402Manager {
  createPaymentRequest(
    from: string,
    to: string,
    amount: string,
    service: string,
    metadata?: Record<string, string | number | boolean | null>,
  ): PaymentRequestResult;
  verifyPayment(
    verificationData: PaymentVerificationParams,
  ): Promise<PaymentVerificationResult>;
  getPaymentRequest(requestId: string): PaymentRequestResult | null;
  isPaymentVerified(requestId: string): boolean;
  cancelPaymentRequest(requestId: string): boolean;
  getPendingPayments(agentAddress: string): PaymentRequestResult[];
  getStatistics(): {
    totalPending: number;
    totalVerified: number;
    totalExpired: number;
  };
}

/**
 * Agent0 client interface
 */
export interface IAgent0Client {
  discoverAgents(filters?: {
    strategies?: string[];
    minReputation?: number;
    markets?: string[];
  }): Promise<AgentProfile[]>;
  getAgentProfile(tokenId: number): Promise<AgentProfile | null>;
  verifyAgent(address: string, tokenId: number): Promise<boolean>;
}

/**
 * Agent discovery service interface
 */
export interface IAgentDiscoveryService {
  discoverAgents(filters?: {
    strategies?: string[];
    minReputation?: number;
    markets?: string[];
    skills?: string[];
    domains?: string[];
  }): Promise<AgentProfile[]>;
  getAgentByAddress(address: string): Promise<AgentProfile | null>;
  getAgentByTokenId(tokenId: number): Promise<AgentProfile | null>;
}

/**
 * Server Configuration
 */
export interface A2AServerConfig {
  port: number;
  host?: string;
  maxConnections?: number;
  messageRateLimit?: number;
  authTimeout?: number;
  enableX402?: boolean;
  enableCoalitions?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  registryClient?: IRegistryClient;
  agent0Client?: IAgent0Client;
  agentDiscovery?: IAgentDiscoveryService;
}

/**
 * Server Options (used internally by websocket-server)
 */
export interface A2AServerOptions
  extends Omit<
    A2AServerConfig,
    "registryClient" | "agent0Client" | "agentDiscovery"
  > {
  registryClient?: IRegistryClient;
  x402Manager?: IX402Manager;
  agent0Client?: IAgent0Client;
  agentDiscovery?: IAgentDiscoveryService;
}

/**
 * Client Configuration
 */
export interface A2AClientConfig {
  endpoint: string;
  credentials: {
    address: string;
    privateKey: string;
    tokenId?: number;
  };
  capabilities: AgentCapabilities;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  heartbeatInterval?: number;
}
