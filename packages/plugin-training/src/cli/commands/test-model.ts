import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { TogetherAIClient } from '../../lib/together-client.js';

export function testModelCommand(program: Command) {
  program
    .command('test-model')
    .description('Test inference or check job status')
    .option('-k, --api-key <key>', 'Together.ai API key (or set TOGETHER_AI_API_KEY)')
    .option('-m, --model <model>', 'Model name for inference')
    .option('-p, --prompt <text>', 'Test prompt')
    .option('-j, --job-id <id>', 'Check status of training job')
    .option('--max-tokens <number>', 'Maximum tokens to generate', '100')
    .option('--list-models', 'List available models')
    .action(async (options) => {
      try {
        const apiKey = options.apiKey || process.env.TOGETHER_AI_API_KEY;
        if (!apiKey) {
          elizaLogger.error(
            '❌ Error: Together.ai API key is required (use --api-key or TOGETHER_AI_API_KEY env var)'
          );
          process.exit(1);
        }

        const client = new TogetherAIClient(apiKey);

        if (options.listModels) {
          elizaLogger.info('📋 Loading available models...');
          const models = await client.getModels();
          elizaLogger.info('\n🤖 Available models for fine-tuning:');
          models.forEach((model) => elizaLogger.info(`  - ${model}`));
          return;
        }

        if (options.jobId) {
          elizaLogger.info(`🔍 Checking job status: ${options.jobId}`);
          const job = await client.getJobStatus(options.jobId);

          elizaLogger.info(`📊 Job ID: ${job.id}`);
          elizaLogger.info(`📊 Status: ${job.status}`);
          elizaLogger.info(`📊 Base Model: ${job.model}`);
          elizaLogger.info(`📊 Created: ${job.createdAt?.toISOString() || 'Unknown'}`);

          if (job.finishedAt) {
            elizaLogger.info(`📊 Finished: ${job.finishedAt.toISOString()}`);
          }

          if (job.fineTunedModel) {
            elizaLogger.info(`🎯 Fine-tuned Model: ${job.fineTunedModel}`);
          }

          if (job.error) {
            elizaLogger.info(`❌ Error: ${job.error}`);
          }

          return;
        }

        if (!options.model || !options.prompt) {
          elizaLogger.error(
            '❌ Error: Both --model and --prompt are required for inference testing'
          );
          elizaLogger.info(
            '💡 Or use --job-id to check training status, or --list-models to see available models'
          );
          process.exit(1);
        }

        const maxTokens = parseInt(options.maxTokens, 10) || 100;

        elizaLogger.info('🧠 Testing inference...');
        elizaLogger.info(`📊 Model: ${options.model}`);
        elizaLogger.info(`📊 Prompt: ${options.prompt}`);
        elizaLogger.info(`📊 Max tokens: ${maxTokens}`);

        const response = await client.testInference(options.model, options.prompt, maxTokens);

        elizaLogger.info('\n✅ Response:');
        elizaLogger.info('─'.repeat(50));
        elizaLogger.info(response);
        elizaLogger.info('─'.repeat(50));
      } catch (error) {
        elizaLogger.error(
          '❌ Error testing model:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}
