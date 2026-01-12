/**
 * Service Configuration - loads from env and jeju-manifest.json
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export type NetworkType = 'localnet' | 'testnet' | 'mainnet';
export type X402NetworkType = 'base' | 'base-sepolia' | 'jeju' | 'jeju-testnet' | 'ethereum' | 'sepolia';

export interface ServiceConfig {
  serviceName: string;
  serviceDescription: string;
  version: string;
  port: number;
  network: NetworkType;
  rpcUrl: string;
  privateKey: string;
  x402Enabled: boolean;
  erc8004Enabled: boolean;
  autoRegister: boolean;
  isPublic: boolean;
  category: string;
  paymentRecipient: string;
  x402Facilitator: string;
  x402Network: X402NetworkType;
  tags: string[];
  agentId?: string;
  identityRegistryAddress?: string;
}

interface JejuManifest {
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  port?: number;
  ports?: { main?: number };
  agent?: {
    enabled?: boolean;
    tags?: string[];
    x402Support?: boolean;
    metadata?: { category?: string };
  };
}

function loadManifest(): JejuManifest {
  const manifestPath = resolve(process.cwd(), 'jeju-manifest.json');
  return existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf-8')) : {};
}

function getNetwork(): NetworkType {
  const env = process.env.JEJU_NETWORK || process.env.NODE_ENV;
  if (env === 'production' || env === 'mainnet') return 'mainnet';
  if (env === 'testnet' || env === 'staging') return 'testnet';
  return 'localnet';
}

function getRpcUrl(network: NetworkType): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const urls: Record<NetworkType, string> = {
    mainnet: process.env.MAINNET_RPC_URL || 'https://mainnet.base.org',
    testnet: process.env.TESTNET_RPC_URL || 'https://sepolia.base.org',
    localnet: process.env.LOCALNET_RPC_URL || 'http://localhost:8545',
  };
  return urls[network];
}

const X402_NETWORKS: Record<NetworkType, X402NetworkType> = {
  mainnet: 'base',
  testnet: 'base-sepolia',
  localnet: 'base-sepolia',
};

const X402_FACILITATORS: Partial<Record<X402NetworkType, string>> = {
  base: 'https://pay.elizaos.ai/v1/base',
  'base-sepolia': 'https://pay-testnet.elizaos.ai/v1/base-sepolia',
  jeju: 'https://pay.elizaos.ai/v1/jeju',
  'jeju-testnet': 'https://pay-testnet.elizaos.ai/v1/jeju-testnet',
  // ethereum and sepolia don't have cloud facilitators yet
};

function getX402Network(network: NetworkType): X402NetworkType {
  const envNetwork = process.env.X402_NETWORK;
  if (envNetwork && envNetwork in X402_FACILITATORS) {
    return envNetwork as X402NetworkType;
  }
  return X402_NETWORKS[network];
}

function getX402Facilitator(x402Network: X402NetworkType): string {
  return process.env.X402_FACILITATOR || X402_FACILITATORS[x402Network] || X402_FACILITATORS['base-sepolia'] || '';
}

export function loadConfig(): ServiceConfig {
  const manifest = loadManifest();
  const network = getNetwork();
  const x402Network = getX402Network(network);
  
  return {
    serviceName: process.env.SERVICE_NAME || manifest.displayName || manifest.name || 'My Service',
    serviceDescription: process.env.SERVICE_DESCRIPTION || manifest.description || 'An MCP + A2A service',
    version: process.env.SERVICE_VERSION || manifest.version || '1.0.0',
    port: parseInt(process.env.PORT || '') || manifest.ports?.main || manifest.port || 3000,
    network,
    rpcUrl: getRpcUrl(network),
    privateKey: process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || '',
    x402Enabled: process.env.X402_ENABLED !== 'false' && (manifest.agent?.x402Support ?? true),
    erc8004Enabled: process.env.ERC8004_ENABLED !== 'false' && (manifest.agent?.enabled ?? true),
    autoRegister: process.env.AUTO_REGISTER === 'true',
    isPublic: process.env.SERVICE_PUBLIC !== 'false',
    category: process.env.SERVICE_CATEGORY || manifest.agent?.metadata?.category || 'service',
    paymentRecipient: process.env.PAYMENT_RECIPIENT || process.env.SERVICE_WALLET || '',
    x402Network,
    x402Facilitator: getX402Facilitator(x402Network),
    tags: manifest.agent?.tags || ['service', 'mcp', 'a2a'],
    agentId: process.env.AGENT_ID,
    identityRegistryAddress: process.env.IDENTITY_REGISTRY_ADDRESS,
  };
}
