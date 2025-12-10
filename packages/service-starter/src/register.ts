#!/usr/bin/env bun
/**
 * Manual ERC-8004 Registration Script
 * 
 * Run this to register your service to the ERC-8004 identity registry.
 * This makes your service discoverable by other agents and the miniapp marketplace.
 * 
 * Usage:
 *   bun run src/register.ts
 *   bun run src/register.ts --network testnet
 */

import { registerService, checkAgentExists, type RegistrationConfig } from './erc8004';
import { loadConfig } from './config';

async function main() {
  const args = process.argv.slice(2);
  const networkArg = args.find(a => a.startsWith('--network='))?.split('=')[1] 
    || (args.includes('--network') ? args[args.indexOf('--network') + 1] : undefined);

  const config = loadConfig();
  
  // Override network if specified
  if (networkArg && ['localnet', 'testnet', 'mainnet'].includes(networkArg)) {
    config.network = networkArg as 'localnet' | 'testnet' | 'mainnet';
  }

  if (!config.privateKey) {
    console.error('Error: PRIVATE_KEY environment variable not set');
    console.error('Set PRIVATE_KEY in your .env file to register your service');
    process.exit(1);
  }

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║           ERC-8004 Service Registration                   ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Service: ${config.serviceName.padEnd(46)}║`);
  console.log(`║  Network: ${config.network.padEnd(46)}║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  // Determine base URL - SERVICE_URL for production, localhost for dev
  const baseUrl = process.env.SERVICE_URL || `http://localhost:${config.port}`;
  
  const registrationConfig: RegistrationConfig = {
    network: config.network,
    privateKey: config.privateKey,
    serviceName: config.serviceName,
    serviceDescription: config.serviceDescription,
    a2aEndpoint: `${baseUrl}/a2a`,
    mcpEndpoint: `${baseUrl}/mcp`,
    tags: config.tags,
    x402Support: config.x402Enabled,
  };
  
  console.log(`Registering with endpoints:`);
  console.log(`  A2A: ${registrationConfig.a2aEndpoint}`);
  console.log(`  MCP: ${registrationConfig.mcpEndpoint}`);
  console.log('');

  const result = await registerService(registrationConfig);

  if (result) {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           Registration Successful!                        ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Agent ID: ${result.agentId.padEnd(45)}║`);
    console.log(`║  TX Hash: ${result.txHash.slice(0, 44).padEnd(46)}║`);
    console.log(`║  Chain ID: ${result.chainId.toString().padEnd(45)}║`);
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Your service is now discoverable by:');
    console.log('  • The elizaOS miniapp marketplace');
    console.log('  • Other autonomous agents');
    console.log('  • Search and directory services');
  } else {
    console.error('Registration failed or was skipped');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Registration error:', error.message);
  process.exit(1);
});
