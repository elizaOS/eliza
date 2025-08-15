import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { DatasetBuilder } from '../../lib/dataset-builder.js';

export function addExampleCommand(program: Command) {
  program
    .command('add-example')
    .description('Add a training example manually')
    .option('-r, --request <text>', 'User request/prompt')
    .option('-s, --response <text>', 'Assistant response')
    .option('-t, --thinking <text>', 'Thinking process (optional)')
    .option('-q, --quality <number>', 'Quality score (0-1)', '0.8')
    .option(
      '-d, --data-dir <path>',
      'Data directory',
      process.env.TRAINING_DATA_DIR || './training-data'
    )
    .action(async (options) => {
      try {
        if (!options.request || !options.response) {
          elizaLogger.error('Error: Both --request and --response are required');
          process.exit(1);
        }

        const quality = parseFloat(options.quality);
        if (isNaN(quality) || quality < 0 || quality > 1) {
          elizaLogger.error('Error: Quality must be a number between 0 and 1');
          process.exit(1);
        }

        const builder = new DatasetBuilder(options.dataDir);
        await builder.loadExamples();

        const id = await builder.addExample({
          input: options.request,
          output: options.response,
          request: options.request,
          response: options.response,
          thinking: options.thinking,
          quality,
        });

        elizaLogger.info(`✅ Added training example: ${id}`);

        const stats = builder.getStats();
        elizaLogger.info(`📊 Total examples: ${stats.totalExamples}`);
        elizaLogger.info(`📊 Average quality: ${stats.averageQuality.toFixed(2)}`);
        elizaLogger.info(`📊 Estimated tokens: ${stats.tokenCount.toLocaleString()}`);
      } catch (error) {
        elizaLogger.error(
          '❌ Error adding example:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}
