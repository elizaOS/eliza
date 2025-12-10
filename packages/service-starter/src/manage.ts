#!/usr/bin/env bun
/**
 * Service Management Script
 * 
 * Manage your service's visibility, endpoints, and settings on the ERC-8004 registry.
 * 
 * Usage:
 *   bun run src/manage.ts publish          # Make service public (discoverable)
 *   bun run src/manage.ts unpublish        # Make service private (hidden)
 *   bun run src/manage.ts status           # Check current status
 *   bun run src/manage.ts set-endpoints    # Update MCP/A2A endpoints
 *   bun run src/manage.ts set-category <category>  # Set marketplace category
 */

import { loadConfig } from './config';
import {
  publishService,
  unpublishService,
  setEndpoints,
  setCategory,
  setX402Support,
  getMarketplaceInfo,
  checkAgentExists,
} from './erc8004';

const commands = {
  publish: 'Make service publicly discoverable in marketplace',
  unpublish: 'Hide service from public listings (still accessible via URL)',
  status: 'Check current service status and settings',
  'set-endpoints': 'Update MCP and A2A endpoints',
  'set-category': 'Set marketplace category',
  'enable-x402': 'Enable x402 payment support',
  'disable-x402': 'Disable x402 payment support',
};

function printHelp() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║           Service Management Commands                     ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  for (const [cmd, desc] of Object.entries(commands)) {
    console.log(`║  ${cmd.padEnd(16)} ${desc.padEnd(40)}║`);
  }
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Examples:');
  console.log('  bun run src/manage.ts publish');
  console.log('  bun run src/manage.ts unpublish');
  console.log('  bun run src/manage.ts status');
  console.log('  bun run src/manage.ts set-category ai');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }
  
  const config = loadConfig();
  
  // Check requirements
  if (!config.agentId) {
    console.error('Error: AGENT_ID environment variable not set');
    console.error('Run "bun run register" first to register your service');
    process.exit(1);
  }
  
  if (!config.privateKey) {
    console.error('Error: PRIVATE_KEY environment variable not set');
    process.exit(1);
  }
  
  console.log(`Managing service: ${config.serviceName}`);
  console.log(`Agent ID: ${config.agentId}`);
  console.log(`Network: ${config.network}`);
  console.log('');
  
  // Verify agent exists
  const exists = await checkAgentExists(config.network, config.agentId);
  if (!exists) {
    console.error(`Error: Agent ${config.agentId} not found on ${config.network}`);
    process.exit(1);
  }
  
  switch (command) {
    case 'publish': {
      console.log('Making service PUBLIC...');
      const txHash = await publishService(config.network, config.privateKey, config.agentId);
      console.log(`✓ Service is now publicly discoverable`);
      console.log(`  TX: ${txHash}`);
      break;
    }
    
    case 'unpublish': {
      console.log('Making service PRIVATE...');
      const txHash = await unpublishService(config.network, config.privateKey, config.agentId);
      console.log(`✓ Service is now hidden from public listings`);
      console.log(`  TX: ${txHash}`);
      break;
    }
    
    case 'status': {
      console.log('Fetching service status...');
      const info = await getMarketplaceInfo(config.network, config.agentId);
      if (!info) {
        console.error('Could not fetch marketplace info');
        process.exit(1);
      }
      
      console.log('');
      console.log('╔═══════════════════════════════════════════════════════════╗');
      console.log('║           Service Status                                  ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║  A2A Endpoint: ${(info.a2aEndpoint || '(not set)').padEnd(41)}║`);
      console.log(`║  MCP Endpoint: ${(info.mcpEndpoint || '(not set)').padEnd(41)}║`);
      console.log(`║  Service Type: ${info.serviceType.padEnd(41)}║`);
      console.log(`║  Category: ${(info.category || '(not set)').padEnd(45)}║`);
      console.log(`║  x402 Support: ${info.x402Supported ? 'Enabled' : 'Disabled'}${' '.repeat(info.x402Supported ? 37 : 36)}║`);
      console.log(`║  Stake Tier: ${info.tier.toString().padEnd(43)}║`);
      console.log(`║  Banned: ${info.banned ? 'YES' : 'No'}${' '.repeat(info.banned ? 46 : 47)}║`);
      console.log('╚═══════════════════════════════════════════════════════════╝');
      break;
    }
    
    case 'set-endpoints': {
      const port = config.port;
      const baseUrl = process.env.SERVICE_URL || `http://localhost:${port}`;
      const a2aEndpoint = `${baseUrl}/a2a`;
      const mcpEndpoint = `${baseUrl}/mcp`;
      
      console.log(`Setting endpoints:`);
      console.log(`  A2A: ${a2aEndpoint}`);
      console.log(`  MCP: ${mcpEndpoint}`);
      
      const txHash = await setEndpoints(
        config.network,
        config.privateKey,
        config.agentId,
        a2aEndpoint,
        mcpEndpoint
      );
      console.log(`✓ Endpoints updated`);
      console.log(`  TX: ${txHash}`);
      break;
    }
    
    case 'set-category': {
      const category = args[1];
      if (!category) {
        console.error('Error: Category required');
        console.error('Usage: bun run src/manage.ts set-category <category>');
        console.error('Examples: ai, compute, storage, game, api, defi');
        process.exit(1);
      }
      
      console.log(`Setting category: ${category}`);
      const txHash = await setCategory(config.network, config.privateKey, config.agentId, category);
      console.log(`✓ Category updated`);
      console.log(`  TX: ${txHash}`);
      break;
    }
    
    case 'enable-x402': {
      console.log('Enabling x402 payment support...');
      const txHash = await setX402Support(config.network, config.privateKey, config.agentId, true);
      console.log(`✓ x402 support enabled`);
      console.log(`  TX: ${txHash}`);
      break;
    }
    
    case 'disable-x402': {
      console.log('Disabling x402 payment support...');
      const txHash = await setX402Support(config.network, config.privateKey, config.agentId, false);
      console.log(`✓ x402 support disabled`);
      console.log(`  TX: ${txHash}`);
      break;
    }
    
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
