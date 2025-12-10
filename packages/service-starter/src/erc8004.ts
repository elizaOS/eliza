/**
 * ERC-8004 Agent Registration
 * 
 * Auto-register your service as an ERC-8004 agent for discovery
 * by other agents and the miniapp marketplace.
 * 
 * @see https://eips.ethereum.org/EIPS/eip-8004
 */

import { ethers, Wallet } from 'ethers';

// ============================================================================
// Types
// ============================================================================

export interface RegistrationConfig {
  network: 'localnet' | 'testnet' | 'mainnet';
  privateKey: string;
  serviceName: string;
  serviceDescription: string;
  a2aEndpoint?: string;
  mcpEndpoint?: string;
  tags?: string[];
  x402Support?: boolean;
}

export interface RegistrationResult {
  agentId: string;
  txHash: string;
  chainId: number;
}

// ============================================================================
// Network Configuration
// ============================================================================

const NETWORK_CONFIG: Record<string, {
  chainId: number;
  rpcUrl: string;
  identityRegistry: string;
}> = {
  localnet: {
    chainId: 1337,
    rpcUrl: process.env.LOCALNET_RPC_URL || 'http://localhost:8545',
    identityRegistry: process.env.IDENTITY_REGISTRY_ADDRESS || '',
  },
  testnet: {
    chainId: 84532, // Base Sepolia
    rpcUrl: process.env.TESTNET_RPC_URL || 'https://sepolia.base.org',
    // Canonical ERC-8004 deployment on Base Sepolia
    identityRegistry: process.env.IDENTITY_REGISTRY_ADDRESS || '0x0F7E3D1b3edcf09f134EA8F1ECa2C6A0e00b3E96',
  },
  mainnet: {
    chainId: 8453, // Base
    rpcUrl: process.env.MAINNET_RPC_URL || 'https://mainnet.base.org',
    identityRegistry: process.env.IDENTITY_REGISTRY_ADDRESS || '',
  },
};

// ============================================================================
// Contract ABI
// ============================================================================

const IDENTITY_REGISTRY_ABI = [
  // Registration
  'function register(string calldata tokenURI_) external returns (uint256 agentId)',
  'function setAgentUri(uint256 agentId, string calldata newTokenURI) external',
  'function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external',
  'function updateTags(uint256 agentId, string[] calldata tags_) external',
  
  // Endpoint Management (MCP/A2A)
  'function setMCPEndpoint(uint256 agentId, string calldata endpoint) external',
  'function setA2AEndpoint(uint256 agentId, string calldata endpoint) external',
  'function setEndpoints(uint256 agentId, string calldata a2aEndpoint, string calldata mcpEndpoint) external',
  'function getMCPEndpoint(uint256 agentId) external view returns (string)',
  'function getA2AEndpoint(uint256 agentId) external view returns (string)',
  
  // Service Configuration
  'function setServiceType(uint256 agentId, string calldata serviceType) external',
  'function setCategory(uint256 agentId, string calldata category) external',
  'function setX402Support(uint256 agentId, bool supported) external',
  'function getX402Support(uint256 agentId) external view returns (bool)',
  'function getServiceType(uint256 agentId) external view returns (string)',
  'function getCategory(uint256 agentId) external view returns (string)',
  
  // Marketplace Info
  'function getMarketplaceInfo(uint256 agentId) external view returns (string a2aEndpoint, string mcpEndpoint, string serviceType, string category, bool x402Supported, uint8 tier, bool banned)',
  
  // View Functions
  'function totalAgents() external view returns (uint256)',
  'function agentExists(uint256 agentId) external view returns (bool)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  
  // Events
  'event Registered(uint256 indexed agentId, address indexed owner, uint8 tier, uint256 stakedAmount, string tokenURI)',
  'event MetadataSet(uint256 indexed agentId, string indexed keyIndex, string key, bytes value)',
];

// ============================================================================
// Registration File Builder
// ============================================================================

function buildRegistrationFile(
  config: RegistrationConfig,
  ownerAddress: string
): Record<string, unknown> {
  const endpoints: Array<{ type: string; value: string; meta?: Record<string, string> }> = [];
  
  if (config.a2aEndpoint) {
    endpoints.push({
      type: 'a2a',
      value: config.a2aEndpoint,
      meta: { version: '0.3.0' },
    });
  }
  
  if (config.mcpEndpoint) {
    endpoints.push({
      type: 'mcp',
      value: config.mcpEndpoint,
      meta: { version: '2024-11-05' },
    });
  }
  
  return {
    name: config.serviceName,
    description: config.serviceDescription,
    endpoints,
    trustModels: ['open'],
    owners: [ownerAddress],
    operators: [],
    active: true,
    x402support: config.x402Support || false,
    metadata: {
      version: '1.0.0',
      createdAt: Math.floor(Date.now() / 1000),
    },
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

// ============================================================================
// Registration Functions
// ============================================================================

/**
 * Register the service as an ERC-8004 agent
 */
export async function registerService(
  config: RegistrationConfig
): Promise<RegistrationResult | null> {
  // Validate configuration
  if (!config.privateKey) {
    console.warn('No private key configured - skipping ERC-8004 registration');
    return null;
  }
  
  const networkConfig = NETWORK_CONFIG[config.network];
  if (!networkConfig.identityRegistry) {
    console.warn(`No IdentityRegistry deployed on ${config.network} - skipping registration`);
    return null;
  }
  
  // Create provider and signer
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(config.privateKey, provider);
  const ownerAddress = await signer.getAddress();
  
  // Build registration data
  const registrationFile = buildRegistrationFile(config, ownerAddress);
  
  // Create contract instance
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  console.log(`Registering ${config.serviceName} on ${config.network}...`);
  console.log(`  Owner: ${ownerAddress}`);
  console.log(`  Registry: ${networkConfig.identityRegistry}`);
  
  // For a real implementation, you would:
  // 1. Upload registrationFile to IPFS to get a tokenURI
  // 2. Call register(tokenURI) on the contract
  // 
  // For now, we'll use an empty tokenURI (can be set later)
  const tokenURI = '';
  
  // Register the agent
  const tx = await identityRegistry.register(tokenURI);
  const receipt = await tx.wait();
  
  // Extract agentId from logs
  const registeredEvent = receipt.logs.find(
    (log: ethers.Log) => log.topics[0] === ethers.id('Registered(uint256,address,uint8,uint256,string)')
  );
  
  let agentId: string;
  if (registeredEvent) {
    agentId = ethers.toBigInt(registeredEvent.topics[1]).toString();
  } else {
    // Fallback: get totalAgents and assume it's the latest
    const total = await identityRegistry.totalAgents();
    agentId = total.toString();
  }
  
  const formattedAgentId = `${networkConfig.chainId}:${agentId}`;
  
  console.log(`Registered successfully!`);
  console.log(`  Agent ID: ${formattedAgentId}`);
  console.log(`  TX Hash: ${receipt.hash}`);
  
  // Set tags if configured
  if (config.tags && config.tags.length > 0) {
    console.log(`Setting tags: ${config.tags.join(', ')}`);
    const tagTx = await identityRegistry.updateTags(agentId, config.tags);
    await tagTx.wait();
  }
  
  // Set endpoints if configured
  if (config.a2aEndpoint || config.mcpEndpoint) {
    console.log(`Setting endpoints...`);
    const endpointTx = await identityRegistry.setEndpoints(
      agentId,
      config.a2aEndpoint || '',
      config.mcpEndpoint || ''
    );
    await endpointTx.wait();
    console.log(`  A2A: ${config.a2aEndpoint || '(none)'}`);
    console.log(`  MCP: ${config.mcpEndpoint || '(none)'}`);
  }
  
  // Set x402 support if configured
  if (config.x402Support !== undefined) {
    console.log(`Setting x402 support: ${config.x402Support}`);
    const x402Tx = await identityRegistry.setX402Support(agentId, config.x402Support);
    await x402Tx.wait();
  }
  
  // Set service type to 'service' for MCP+A2A services
  console.log(`Setting service type: service`);
  const typeTx = await identityRegistry.setServiceType(agentId, 'service');
  await typeTx.wait();
  
  // Set active status (public by default)
  console.log(`Setting visibility: PUBLIC`);
  const activeTx = await identityRegistry.setMetadata(
    agentId,
    'active',
    ethers.toUtf8Bytes('true')
  );
  await activeTx.wait();
  
  return {
    agentId: formattedAgentId,
    txHash: receipt.hash,
    chainId: networkConfig.chainId,
  };
}

/**
 * Check if an agent exists
 */
export async function checkAgentExists(
  network: 'localnet' | 'testnet' | 'mainnet',
  agentId: string
): Promise<boolean> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) return false;
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    provider
  );
  
  // Parse agentId (format: chainId:tokenId)
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  return identityRegistry.agentExists(tokenId);
}

/**
 * Update agent metadata
 */
export async function updateAgentMetadata(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  key: string,
  value: string
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const tx = await identityRegistry.setMetadata(
    tokenId,
    key,
    ethers.toUtf8Bytes(value)
  );
  const receipt = await tx.wait();
  
  return receipt.hash;
}

// ============================================================================
// Endpoint Management
// ============================================================================

/**
 * Set MCP endpoint for a registered agent
 */
export async function setMCPEndpoint(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  endpoint: string
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const tx = await identityRegistry.setMCPEndpoint(tokenId, endpoint);
  const receipt = await tx.wait();
  
  console.log(`MCP endpoint updated for agent ${agentId}: ${endpoint}`);
  return receipt.hash;
}

/**
 * Set A2A endpoint for a registered agent
 */
export async function setA2AEndpoint(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  endpoint: string
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const tx = await identityRegistry.setA2AEndpoint(tokenId, endpoint);
  const receipt = await tx.wait();
  
  console.log(`A2A endpoint updated for agent ${agentId}: ${endpoint}`);
  return receipt.hash;
}

/**
 * Set both endpoints at once
 */
export async function setEndpoints(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  a2aEndpoint: string,
  mcpEndpoint: string
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const tx = await identityRegistry.setEndpoints(tokenId, a2aEndpoint, mcpEndpoint);
  const receipt = await tx.wait();
  
  console.log(`Endpoints updated for agent ${agentId}`);
  return receipt.hash;
}

// ============================================================================
// Visibility Management
// ============================================================================

/**
 * Set service active/inactive status (visibility)
 * 
 * When active=true, the service is publicly discoverable.
 * When active=false, the service is hidden from public listings but still accessible if URL is known.
 */
export async function setServiceActive(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  active: boolean
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  // Set the 'active' metadata key
  const tx = await identityRegistry.setMetadata(
    tokenId,
    'active',
    ethers.toUtf8Bytes(active ? 'true' : 'false')
  );
  const receipt = await tx.wait();
  
  console.log(`Service ${agentId} is now ${active ? 'PUBLIC' : 'PRIVATE'}`);
  return receipt.hash;
}

/**
 * Convenience function to make a service public (discoverable)
 */
export async function publishService(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string
): Promise<string> {
  return setServiceActive(network, privateKey, agentId, true);
}

/**
 * Convenience function to make a service private (hidden from listings)
 */
export async function unpublishService(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string
): Promise<string> {
  return setServiceActive(network, privateKey, agentId, false);
}

/**
 * Set x402 payment support status
 */
export async function setX402Support(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  supported: boolean
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const tx = await identityRegistry.setX402Support(tokenId, supported);
  const receipt = await tx.wait();
  
  console.log(`x402 support for ${agentId}: ${supported ? 'ENABLED' : 'DISABLED'}`);
  return receipt.hash;
}

/**
 * Set service type (agent, mcp, app, service)
 */
export async function setServiceType(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  serviceType: 'agent' | 'mcp' | 'app' | 'service'
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const tx = await identityRegistry.setServiceType(tokenId, serviceType);
  const receipt = await tx.wait();
  
  console.log(`Service type for ${agentId}: ${serviceType}`);
  return receipt.hash;
}

/**
 * Set service category for marketplace discovery
 */
export async function setCategory(
  network: 'localnet' | 'testnet' | 'mainnet',
  privateKey: string,
  agentId: string,
  category: string
): Promise<string> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    throw new Error(`No IdentityRegistry on ${network}`);
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new Wallet(privateKey, provider);
  
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    signer
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const tx = await identityRegistry.setCategory(tokenId, category);
  const receipt = await tx.wait();
  
  console.log(`Category for ${agentId}: ${category}`);
  return receipt.hash;
}

// ============================================================================
// Read Functions
// ============================================================================

export interface MarketplaceInfo {
  a2aEndpoint: string;
  mcpEndpoint: string;
  serviceType: string;
  category: string;
  x402Supported: boolean;
  tier: number;
  banned: boolean;
}

/**
 * Get marketplace info for an agent
 */
export async function getMarketplaceInfo(
  network: 'localnet' | 'testnet' | 'mainnet',
  agentId: string
): Promise<MarketplaceInfo | null> {
  const networkConfig = NETWORK_CONFIG[network];
  if (!networkConfig.identityRegistry) {
    return null;
  }
  
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const identityRegistry = new ethers.Contract(
    networkConfig.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    provider
  );
  
  const tokenId = agentId.includes(':') ? agentId.split(':')[1] : agentId;
  
  const info = await identityRegistry.getMarketplaceInfo(tokenId);
  
  return {
    a2aEndpoint: info[0],
    mcpEndpoint: info[1],
    serviceType: info[2],
    category: info[3],
    x402Supported: info[4],
    tier: Number(info[5]),
    banned: info[6],
  };
}
