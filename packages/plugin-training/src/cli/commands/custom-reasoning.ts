import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { promises as fs } from 'fs';
import type { CustomModelType, ExportOptions } from '../../interfaces/CustomReasoningService.js';

/**
 * CLI commands for managing custom reasoning service
 */

export function customReasoningCommands(program: Command) {
  const reasoning = program
    .command('reasoning')
    .description('Manage custom reasoning service and models');

  // Model management commands
  const models = reasoning.command('models').description('Manage custom reasoning models');

  models
    .command('list')
    .description('List all custom reasoning models and their status')
    .action(async () => {
      try {
        // This would need to be called with a runtime instance
        elizaLogger.info('Custom Reasoning Models Status:');
        elizaLogger.info('');
        elizaLogger.info('📊 Model configurations:');
        elizaLogger.info('  • should-respond: Ultra-small DeepSeek 1.5B model');
        elizaLogger.info('  • planning: Medium DeepSeek Qwen 14B model');
        elizaLogger.info('  • coding: Large DeepSeek Llama 67B model');
        elizaLogger.info('');
        elizaLogger.info(
          '⚙️  To get live status, run this command from within an ElizaOS runtime context.'
        );
      } catch (error) {
        elizaLogger.error('❌ Error listing models:', error);
        process.exit(1);
      }
    });

  models
    .command('enable')
    .description('Enable a custom reasoning model')
    .argument('<model-type>', 'Model type (should-respond, planning, coding)')
    .action(async (modelType: string) => {
      try {
        elizaLogger.info(`🚀 Enabling custom reasoning model: ${modelType}`);
        elizaLogger.info('');
        elizaLogger.info('This command should be run from within an ElizaOS runtime context.');
        elizaLogger.info('Add this to your agent configuration:');
        elizaLogger.info('');
        elizaLogger.info(
          `REASONING_SERVICE_${modelType.toUpperCase().replace('-', '_')}_ENABLED=true`
        );
      } catch (error) {
        elizaLogger.error('❌ Error enabling model:', error);
        process.exit(1);
      }
    });

  models
    .command('disable')
    .description('Disable a custom reasoning model')
    .argument('<model-type>', 'Model type (should-respond, planning, coding)')
    .action(async (modelType: string) => {
      try {
        elizaLogger.info(`🛑 Disabling custom reasoning model: ${modelType}`);
        elizaLogger.info('');
        elizaLogger.info('This command should be run from within an ElizaOS runtime context.');
        elizaLogger.info('Set this in your agent configuration:');
        elizaLogger.info('');
        elizaLogger.info(
          `REASONING_SERVICE_${modelType.toUpperCase().replace('-', '_')}_ENABLED=false`
        );
      } catch (error) {
        elizaLogger.error('❌ Error disabling model:', error);
        process.exit(1);
      }
    });

  models
    .command('status')
    .description('Show status of all custom reasoning models')
    .action(async () => {
      try {
        elizaLogger.info('📈 Custom Reasoning Status');
        elizaLogger.info('');
        elizaLogger.info('Environment Variables:');
        elizaLogger.info(
          `  REASONING_SERVICE_ENABLED: ${process.env.REASONING_SERVICE_ENABLED || 'not set'}`
        );
        elizaLogger.info(
          `  TOGETHER_AI_API_KEY: ${process.env.TOGETHER_AI_API_KEY ? '✅ Set' : '❌ Not set'}`
        );
        elizaLogger.info('');
        elizaLogger.info('Model Configuration:');
        elizaLogger.info(
          `  Should Respond: ${process.env.REASONING_SERVICE_SHOULD_RESPOND_ENABLED || 'false'}`
        );
        elizaLogger.info(
          `  Planning: ${process.env.REASONING_SERVICE_PLANNING_ENABLED || 'false'}`
        );
        elizaLogger.info(`  Coding: ${process.env.REASONING_SERVICE_CODING_ENABLED || 'false'}`);
        elizaLogger.info('');
        elizaLogger.info('Cost Management:');
        elizaLogger.info(
          `  Budget Limit: $${process.env.REASONING_SERVICE_BUDGET_LIMIT || 'not set'}`
        );
        elizaLogger.info(
          `  Auto Shutdown: ${process.env.REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES || '30'} minutes`
        );
      } catch (error) {
        elizaLogger.error('❌ Error getting status:', error);
        process.exit(1);
      }
    });

  models
    .command('deploy')
    .description('Deploy a model to Together.ai for inference')
    .argument('<model-name>', 'Model name to deploy')
    .action(async (modelName: string) => {
      try {
        elizaLogger.info(`🚀 Deploying model: ${modelName}`);
        elizaLogger.info('');
        elizaLogger.info('This would deploy the model to Together.ai inference endpoint.');
        elizaLogger.info('Implementation requires runtime context with Together.ai client.');
      } catch (error) {
        elizaLogger.error('❌ Error deploying model:', error);
        process.exit(1);
      }
    });

  models
    .command('undeploy')
    .description('Undeploy a model to save costs')
    .argument('<model-name>', 'Model name to undeploy')
    .action(async (modelName: string) => {
      try {
        elizaLogger.info(`🛑 Undeploying model: ${modelName}`);
        elizaLogger.info('');
        elizaLogger.info('This would undeploy the model from Together.ai to save costs.');
        elizaLogger.info('Implementation requires runtime context with Together.ai client.');
      } catch (error) {
        elizaLogger.error('❌ Error undeploying model:', error);
        process.exit(1);
      }
    });

  // Training data commands
  const data = reasoning.command('data').description('Manage training data collection and export');

  data
    .command('export')
    .description('Export training data for model fine-tuning')
    .option('-m, --model-type <type>', 'Model type to export (should-respond, planning, coding)')
    .option('-f, --format <format>', 'Export format (jsonl, json)', 'jsonl')
    .option('-o, --output <file>', 'Output file path')
    .option('-l, --limit <number>', 'Limit number of samples', '1000')
    .option('--start-date <date>', 'Start date for export (YYYY-MM-DD)')
    .option('--end-date <date>', 'End date for export (YYYY-MM-DD)')
    .action(async (options) => {
      try {
        elizaLogger.info('📤 Exporting training data...');
        elizaLogger.info('');

        const exportOptions: ExportOptions = {
          modelType: options.modelType as CustomModelType,
          format: options.format,
          limit: parseInt(options.limit, 10),
          startDate: options.startDate ? new Date(options.startDate) : undefined,
          endDate: options.endDate ? new Date(options.endDate) : undefined,
        };

        elizaLogger.info('Export Configuration:');
        elizaLogger.info(`  Model Type: ${exportOptions.modelType || 'all'}`);
        elizaLogger.info(`  Format: ${exportOptions.format}`);
        elizaLogger.info(`  Limit: ${exportOptions.limit}`);
        if (exportOptions.startDate) {
          elizaLogger.info(`  Start Date: ${exportOptions.startDate.toISOString()}`);
        }
        if (exportOptions.endDate) {
          elizaLogger.info(`  End Date: ${exportOptions.endDate.toISOString()}`);
        }
        elizaLogger.info('');

        // Generate output filename if not provided
        const timestamp = new Date().toISOString().split('T')[0];
        const modelSuffix = exportOptions.modelType ? `-${exportOptions.modelType}` : '-all';
        const defaultOutput = `training-data${modelSuffix}-${timestamp}.${exportOptions.format}`;
        const outputFile = options.output || defaultOutput;

        elizaLogger.info(`📁 Output file: ${outputFile}`);
        elizaLogger.info('');
        elizaLogger.info(
          '⚠️  This command requires an active ElizaOS runtime context to access training data.'
        );
        elizaLogger.info(
          '   Run this command from within your ElizaOS project or plugin directory.'
        );
      } catch (error) {
        elizaLogger.error('❌ Error exporting training data:', error);
        process.exit(1);
      }
    });

  data
    .command('stats')
    .description('Show training data statistics')
    .action(async () => {
      try {
        elizaLogger.info('📊 Training Data Statistics');
        elizaLogger.info('');
        elizaLogger.info('⚠️  This command requires an active ElizaOS runtime context.');
        elizaLogger.info('   Statistics would include:');
        elizaLogger.info('   • Total samples collected');
        elizaLogger.info('   • Samples by model type');
        elizaLogger.info('   • Data quality assessment');
        elizaLogger.info('   • Recent collection activity');
        elizaLogger.info('   • Storage usage');
      } catch (error) {
        elizaLogger.error('❌ Error getting stats:', error);
        process.exit(1);
      }
    });

  data
    .command('cleanup')
    .description('Clean up old training data')
    .option('-d, --days <days>', 'Retention period in days', '30')
    .option('--dry-run', 'Show what would be deleted without actually deleting')
    .action(async (options) => {
      try {
        const retentionDays = parseInt(options.days, 10);
        elizaLogger.info(`🧹 Cleaning up training data older than ${retentionDays} days`);

        if (options.dryRun) {
          elizaLogger.info('');
          elizaLogger.info('🔍 DRY RUN - No data will be deleted');
        }

        elizaLogger.info('');
        elizaLogger.info('⚠️  This command requires an active ElizaOS runtime context.');
      } catch (error) {
        elizaLogger.error('❌ Error cleaning up data:', error);
        process.exit(1);
      }
    });

  // Cost management commands
  const costs = reasoning.command('costs').description('Manage costs and budgets');

  costs
    .command('report')
    .description('Show cost report for custom reasoning')
    .action(async () => {
      try {
        elizaLogger.info('💰 Cost Report');
        elizaLogger.info('');
        elizaLogger.info('⚠️  This command requires an active ElizaOS runtime context.');
        elizaLogger.info('   Report would include:');
        elizaLogger.info('   • Total costs by model');
        elizaLogger.info('   • Usage metrics');
        elizaLogger.info('   • Budget status');
        elizaLogger.info('   • Cost per request');
        elizaLogger.info('   • Deployment uptime');
      } catch (error) {
        elizaLogger.error('❌ Error generating cost report:', error);
        process.exit(1);
      }
    });

  costs
    .command('set-budget')
    .description('Set budget limit for custom reasoning')
    .argument('<amount>', 'Budget limit in USD')
    .action(async (amount: string) => {
      try {
        const budgetLimit = parseFloat(amount);
        if (isNaN(budgetLimit) || budgetLimit <= 0) {
          elizaLogger.error('❌ Invalid budget amount. Must be a positive number.');
          process.exit(1);
        }

        elizaLogger.info(`💰 Setting budget limit to $${budgetLimit}`);
        elizaLogger.info('');
        elizaLogger.info('Environment variable to set:');
        elizaLogger.info(`REASONING_SERVICE_BUDGET_LIMIT=${budgetLimit}`);
        elizaLogger.info('');
        elizaLogger.info(
          '⚠️  Budget enforcement requires the custom reasoning service to be running.'
        );
      } catch (error) {
        elizaLogger.error('❌ Error setting budget:', error);
        process.exit(1);
      }
    });

  costs
    .command('auto-shutdown')
    .description('Configure automatic model shutdown')
    .option('-m, --minutes <minutes>', 'Idle minutes before shutdown', '30')
    .action(async (options) => {
      try {
        const idleMinutes = parseInt(options.minutes, 10);
        elizaLogger.info(`⏰ Setting auto-shutdown to ${idleMinutes} minutes of idle time`);
        elizaLogger.info('');
        elizaLogger.info('Environment variable to set:');
        elizaLogger.info(`REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES=${idleMinutes}`);
      } catch (error) {
        elizaLogger.error('❌ Error configuring auto-shutdown:', error);
        process.exit(1);
      }
    });

  // Configuration commands
  reasoning
    .command('config')
    .description('Show current configuration')
    .action(async () => {
      try {
        elizaLogger.info('⚙️  Custom Reasoning Configuration');
        elizaLogger.info('');

        elizaLogger.info('🔧 Core Settings:');
        elizaLogger.info(`  Enabled: ${process.env.REASONING_SERVICE_ENABLED || 'false'}`);
        elizaLogger.info(
          `  API Key: ${process.env.TOGETHER_AI_API_KEY ? '✅ Configured' : '❌ Missing'}`
        );
        elizaLogger.info('');

        elizaLogger.info('🤖 Models:');
        elizaLogger.info(
          `  Should Respond: ${process.env.REASONING_SERVICE_SHOULD_RESPOND_ENABLED || 'false'}`
        );
        elizaLogger.info(
          `    Model: ${process.env.REASONING_SERVICE_SHOULD_RESPOND_MODEL || 'moonmakesmagic/DeepSeek-R1-Distill-Qwen-1.5B-shouldrespond'}`
        );
        elizaLogger.info(
          `  Planning: ${process.env.REASONING_SERVICE_PLANNING_ENABLED || 'false'}`
        );
        elizaLogger.info(
          `    Model: ${process.env.REASONING_SERVICE_PLANNING_MODEL || 'moonmakesmagic/DeepSeek-Qwen-14B-planning'}`
        );
        elizaLogger.info(`  Coding: ${process.env.REASONING_SERVICE_CODING_ENABLED || 'false'}`);
        elizaLogger.info(
          `    Model: ${process.env.REASONING_SERVICE_CODING_MODEL || 'moonmakesmagic/DeepSeek-Llama-67B-coding'}`
        );
        elizaLogger.info('');

        elizaLogger.info('💰 Cost Management:');
        elizaLogger.info(
          `  Budget Limit: $${process.env.REASONING_SERVICE_BUDGET_LIMIT || 'not set'}`
        );
        elizaLogger.info(
          `  Auto Shutdown: ${process.env.REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES || '30'} minutes`
        );
        elizaLogger.info(
          `  Max Cost/Hour: $${process.env.REASONING_SERVICE_MAX_COST_PER_HOUR || '10'}`
        );
        elizaLogger.info('');

        elizaLogger.info('📊 Training Data:');
        elizaLogger.info(
          `  Collection: ${process.env.REASONING_SERVICE_COLLECT_TRAINING_DATA || 'false'}`
        );
        elizaLogger.info(
          `  Max Samples: ${process.env.REASONING_SERVICE_MAX_SAMPLES_PER_MODEL || '10000'}`
        );
        elizaLogger.info(
          `  Retention: ${process.env.REASONING_SERVICE_RETENTION_DAYS || '30'} days`
        );
        elizaLogger.info('');

        elizaLogger.info('🔧 Proxy Settings:');
        elizaLogger.info(`  Anthropic Proxy: ${process.env.ANTHROPIC_PROXY_ENABLED || 'false'}`);
        elizaLogger.info(`  Proxy Port: ${process.env.ANTHROPIC_PROXY_PORT || '8001'}`);
      } catch (error) {
        elizaLogger.error('❌ Error showing configuration:', error);
        process.exit(1);
      }
    });

  reasoning
    .command('setup')
    .description('Interactive setup for custom reasoning')
    .action(async () => {
      try {
        elizaLogger.info('🚀 Custom Reasoning Setup');
        elizaLogger.info('');
        elizaLogger.info(
          'This interactive setup will help you configure custom reasoning for ElizaOS.'
        );
        elizaLogger.info('');

        elizaLogger.info('📋 Required environment variables:');
        elizaLogger.info('');
        elizaLogger.info('1. TOGETHER_AI_API_KEY=your_api_key_here');
        elizaLogger.info('   Get your API key from: https://api.together.xyz/settings/api-keys');
        elizaLogger.info('');
        elizaLogger.info('2. REASONING_SERVICE_ENABLED=true');
        elizaLogger.info('   Enable the custom reasoning service');
        elizaLogger.info('');
        elizaLogger.info('3. Choose which models to enable:');
        elizaLogger.info('   REASONING_SERVICE_SHOULD_RESPOND_ENABLED=true');
        elizaLogger.info('   REASONING_SERVICE_PLANNING_ENABLED=true');
        elizaLogger.info('   REASONING_SERVICE_CODING_ENABLED=true');
        elizaLogger.info('');
        elizaLogger.info('4. Optional cost management:');
        elizaLogger.info('   REASONING_SERVICE_BUDGET_LIMIT=100');
        elizaLogger.info('   REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES=30');
        elizaLogger.info('');
        elizaLogger.info('5. Optional training data collection:');
        elizaLogger.info('   REASONING_SERVICE_COLLECT_TRAINING_DATA=true');
        elizaLogger.info('');
        elizaLogger.info('💡 Add these to your .env file and restart your ElizaOS agent.');
      } catch (error) {
        elizaLogger.error('❌ Error in setup:', error);
        process.exit(1);
      }
    });
}

// Helper to create sample configuration file
export async function createSampleConfig(outputPath: string): Promise<void> {
  const sampleConfig = `# Custom Reasoning Configuration for ElizaOS
# Add these variables to your .env file

# Core Settings
REASONING_SERVICE_ENABLED=true
TOGETHER_AI_API_KEY=your_api_key_here

# Model Configuration
REASONING_SERVICE_SHOULD_RESPOND_ENABLED=true
REASONING_SERVICE_SHOULD_RESPOND_MODEL=moonmakesmagic/DeepSeek-R1-Distill-Qwen-1.5B-shouldrespond

REASONING_SERVICE_PLANNING_ENABLED=true
REASONING_SERVICE_PLANNING_MODEL=moonmakesmagic/DeepSeek-Qwen-14B-planning

REASONING_SERVICE_CODING_ENABLED=false
REASONING_SERVICE_CODING_MODEL=moonmakesmagic/DeepSeek-Llama-67B-coding

# Cost Management
REASONING_SERVICE_BUDGET_LIMIT=100
REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES=30
REASONING_SERVICE_MAX_COST_PER_HOUR=10

# Training Data Collection
REASONING_SERVICE_COLLECT_TRAINING_DATA=true
REASONING_SERVICE_MAX_SAMPLES_PER_MODEL=10000
REASONING_SERVICE_RETENTION_DAYS=30

# Anthropic Proxy (for autocoder integration)
ANTHROPIC_PROXY_ENABLED=false
ANTHROPIC_PROXY_PORT=8001
`;

  await fs.writeFile(outputPath, sampleConfig, 'utf-8');
}
