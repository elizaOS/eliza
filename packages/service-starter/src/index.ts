/**
 * MCP + A2A Service Starter
 * 
 * This template provides a complete service that can be:
 * - Discovered by other agents via A2A (Agent-to-Agent) protocol
 * - Used by AI assistants via MCP (Model Context Protocol)
 * - Monetized via x402 micropayments
 * - Auto-registered to ERC-8004 identity registry
 * - Deployed to elizaOS cloud
 * 
 * @see https://elizaos.ai/docs/services
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import { createMCPServer, type MCPConfig } from './mcp-server';
import { createA2AServer, type A2AConfig } from './a2a-server';
import { registerService, type RegistrationConfig } from './erc8004';
import { loadConfig, type ServiceConfig } from './config';

// ============================================================================
// Service Configuration
// ============================================================================

const config = loadConfig();

// ============================================================================
// Initialize Servers
// ============================================================================

const app = new Hono();

// Enable CORS for cross-origin requests
app.use('/*', cors());

// Serve static files (including .well-known/agent-card.json)
app.use('/public/*', serveStatic({ root: './' }));

// Create MCP and A2A servers
const mcpServer = createMCPServer(config);
const a2aServer = createA2AServer(config);

// Mount MCP endpoints at /mcp
app.route('/mcp', mcpServer.getRouter());

// Mount A2A endpoints at /a2a  
app.route('/a2a', a2aServer.getRouter());

// ============================================================================
// Discovery Endpoints
// ============================================================================

// Serve agent-card.json for A2A discovery
app.get('/.well-known/agent-card.json', (c) => {
  return c.json(a2aServer.getAgentCard());
});

// Root endpoint - service info
app.get('/', (c) => {
  return c.json({
    name: config.serviceName,
    description: config.serviceDescription,
    version: config.version,
    endpoints: {
      a2a: '/a2a',
      mcp: '/mcp',
      agentCard: '/.well-known/agent-card.json',
      health: '/health',
    },
    capabilities: {
      mcp: true,
      a2a: true,
      x402: config.x402Enabled,
      erc8004: config.erc8004Enabled,
    },
  });
});

// Health check endpoint (required for elizaOS cloud deployment)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: config.serviceName,
    version: config.version,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Alternative health check paths for compatibility
app.get('/healthz', (c) => c.json({ status: 'ok' }));
app.get('/ready', (c) => c.json({ status: 'ready' }));

// ============================================================================
// Startup
// ============================================================================

async function start() {
  // PORT from environment takes precedence (required for elizaOS cloud)
  const port = parseInt(process.env.PORT || '') || config.port;

  // Auto-register to ERC-8004 if enabled
  // Note: SERVICE_URL should be set in production deployments
  // In cloud deployments, the deploy command sets SERVICE_URL to the load balancer URL
  if (config.erc8004Enabled && config.autoRegister) {
    // Determine base URL - SERVICE_URL for production, localhost for dev
    const baseUrl = process.env.SERVICE_URL || `http://localhost:${port}`;
    
    // Skip registration with localhost URLs in production mode
    if (process.env.NODE_ENV === 'production' && baseUrl.includes('localhost')) {
      console.log('Skipping ERC-8004 registration: SERVICE_URL not set (will register once URL is known)');
    } else {
      console.log('Auto-registering service to ERC-8004...');
      console.log(`  Base URL: ${baseUrl}`);
      
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
      
      const registration = await registerService(registrationConfig);
      if (registration) {
        console.log(`Registered as ERC-8004 agent: ${registration.agentId}`);
      }
    }
  }

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           MCP + A2A Service Started                       ║
╠═══════════════════════════════════════════════════════════╣
║  Service: ${config.serviceName.padEnd(46)}║
║  Port: ${port.toString().padEnd(49)}║
║  MCP Endpoint: http://localhost:${port}/mcp${' '.repeat(21)}║
║  A2A Endpoint: http://localhost:${port}/a2a${' '.repeat(21)}║
║  Agent Card: http://localhost:${port}/.well-known/agent-card.json  ║
╠═══════════════════════════════════════════════════════════╣
║  x402 Payments: ${config.x402Enabled ? 'Enabled' : 'Disabled'}${' '.repeat(config.x402Enabled ? 37 : 36)}║
║  ERC-8004: ${config.erc8004Enabled ? 'Enabled' : 'Disabled'}${' '.repeat(config.erc8004Enabled ? 43 : 42)}║
╚═══════════════════════════════════════════════════════════╝
`);

  return { port, fetch: app.fetch };
}

// Export for Bun
const server = await start();
export default {
  port: server.port,
  fetch: server.fetch,
};
