/**
 * Example: ElizaOS CLI Integration
 * 
 * This example shows how ElizaOS can be integrated with the existing CLI
 * to provide a unified command-line interface for managing the entire system.
 */

import { ElizaOS, Character, Plugin } from '@elizaos/core';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Create CLI program
const program = new Command();

program
  .name('elizaos')
  .description('ElizaOS CLI - Manage your AI agent ecosystem')
  .version('1.0.0');

// Initialize command
program
  .command('init')
  .description('Initialize a new ElizaOS instance')
  .option('-n, --name <name>', 'Instance name', 'MyElizaOS')
  .option('-p, --port <port>', 'Server port', '3000')
  .option('--max-agents <number>', 'Maximum number of agents', '10')
  .option('--clustering', 'Enable clustering')
  .action(async (options) => {
    console.log('Initializing ElizaOS...');
    
    const elizaos = new ElizaOS({
      name: options.name,
      serverConfig: {
        enabled: true,
        port: parseInt(options.port),
      },
      maxAgents: parseInt(options.maxAgents),
      clustering: options.clustering,
    });

    await elizaos.initialize();
    console.log(`✓ ElizaOS "${options.name}" initialized`);
    
    // Save instance reference (in a real implementation, this would be persisted)
    global.elizaos = elizaos;
  });

// Start command
program
  .command('start')
  .description('Start the ElizaOS server')
  .action(async () => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    console.log('Starting ElizaOS server...');
    await global.elizaos.start();
    console.log('✓ Server started');
  });

// Create agent command
program
  .command('agent:create')
  .description('Create a new agent')
  .argument('<character-file>', 'Path to character JSON file')
  .option('--auto-start', 'Automatically start the agent')
  .option('--plugins <plugins...>', 'Plugins to load')
  .action(async (characterFile, options) => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    try {
      // Load character from file
      const characterPath = resolve(process.cwd(), characterFile);
      const characterData = JSON.parse(readFileSync(characterPath, 'utf-8'));
      
      console.log(`Creating agent "${characterData.name}"...`);
      
      const agentId = await global.elizaos.createAgent({
        character: characterData as Character,
        autoStart: options.autoStart || false,
      });

      console.log(`✓ Agent created with ID: ${agentId}`);
      
      if (options.autoStart) {
        console.log('✓ Agent started automatically');
      }
    } catch (error) {
      console.error('Failed to create agent:', error.message);
      process.exit(1);
    }
  });

// List agents command
program
  .command('agent:list')
  .description('List all agents')
  .option('--status <status>', 'Filter by status')
  .action(async (options) => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    const agents = options.status 
      ? global.elizaos.getAgentsByStatus(options.status)
      : global.elizaos.getAllAgents();

    if (agents.length === 0) {
      console.log('No agents found');
      return;
    }

    console.log('\nAgents:');
    console.log('-------');
    agents.forEach(agent => {
      console.log(`• ${agent.name} (${agent.id})`);
      console.log(`  Status: ${agent.status}`);
      console.log(`  Created: ${new Date(agent.createdAt).toLocaleString()}`);
      if (agent.plugins.length > 0) {
        console.log(`  Plugins: ${agent.plugins.join(', ')}`);
      }
      console.log('');
    });
  });

// Start agent command
program
  .command('agent:start <agent-id>')
  .description('Start a specific agent')
  .action(async (agentId) => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    try {
      console.log(`Starting agent ${agentId}...`);
      await global.elizaos.startAgent(agentId);
      console.log('✓ Agent started');
    } catch (error) {
      console.error('Failed to start agent:', error.message);
      process.exit(1);
    }
  });

// Stop agent command
program
  .command('agent:stop <agent-id>')
  .description('Stop a specific agent')
  .action(async (agentId) => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    try {
      console.log(`Stopping agent ${agentId}...`);
      await global.elizaos.stopAgent(agentId);
      console.log('✓ Agent stopped');
    } catch (error) {
      console.error('Failed to stop agent:', error.message);
      process.exit(1);
    }
  });

// Remove agent command
program
  .command('agent:remove <agent-id>')
  .description('Remove an agent')
  .option('--force', 'Force removal even if agent is running')
  .action(async (agentId, options) => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    try {
      if (options.force) {
        await global.elizaos.stopAgent(agentId).catch(() => {});
      }
      
      console.log(`Removing agent ${agentId}...`);
      await global.elizaos.removeAgent(agentId);
      console.log('✓ Agent removed');
    } catch (error) {
      console.error('Failed to remove agent:', error.message);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show ElizaOS system status')
  .action(async () => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    const status = global.elizaos.getSystemStatus();
    
    console.log('\nElizaOS System Status');
    console.log('====================');
    console.log(`Name: ${global.elizaos.name}`);
    console.log(`Uptime: ${Math.floor(status.uptime / 1000)}s`);
    console.log(`Total Agents: ${status.totalAgents}`);
    console.log(`Active Agents: ${status.activeAgents}`);
    console.log(`Plugins: ${status.plugins.length}`);
    console.log(`Services: ${Object.keys(status.services).length}`);
    console.log('\nMemory Usage:');
    console.log(`  RSS: ${Math.round(status.memoryUsage.rss / 1024 / 1024)}MB`);
    console.log(`  Heap Used: ${Math.round(status.memoryUsage.heapUsed / 1024 / 1024)}MB`);
    console.log(`  Heap Total: ${Math.round(status.memoryUsage.heapTotal / 1024 / 1024)}MB`);
  });

// Health check command
program
  .command('health')
  .description('Check ElizaOS health')
  .action(async () => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    const isHealthy = await global.elizaos.healthCheck();
    
    if (isHealthy) {
      console.log('✓ ElizaOS is healthy');
    } else {
      console.error('✗ ElizaOS is unhealthy');
      process.exit(1);
    }
  });

// Plugin commands
program
  .command('plugin:register <plugin-path>')
  .description('Register a global plugin')
  .action(async (pluginPath) => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    try {
      // In a real implementation, this would dynamically load the plugin
      const plugin = await import(resolve(process.cwd(), pluginPath));
      
      console.log(`Registering plugin "${plugin.default.name}"...`);
      await global.elizaos.registerGlobalPlugin(plugin.default as Plugin);
      console.log('✓ Plugin registered');
    } catch (error) {
      console.error('Failed to register plugin:', error.message);
      process.exit(1);
    }
  });

// Stop command
program
  .command('stop')
  .description('Stop ElizaOS')
  .action(async () => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized.');
      process.exit(1);
    }

    console.log('Stopping ElizaOS...');
    await global.elizaos.stop();
    console.log('✓ ElizaOS stopped');
  });

// Interactive mode command
program
  .command('interactive')
  .description('Start interactive REPL with ElizaOS context')
  .action(async () => {
    if (!global.elizaos) {
      console.error('ElizaOS not initialized. Run "elizaos init" first.');
      process.exit(1);
    }

    console.log('Starting interactive mode...');
    console.log('ElizaOS instance available as "elizaos"');
    console.log('Type ".exit" to quit\n');

    // In a real implementation, this would start a REPL
    const repl = require('repl');
    const replServer = repl.start('> ');
    replServer.context.elizaos = global.elizaos;
  });

// Parse command line arguments
program.parse(process.argv);

// Export for use in other scripts
export { program };

