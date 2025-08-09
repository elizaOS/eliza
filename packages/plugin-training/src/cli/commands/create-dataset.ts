import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { DatasetBuilder } from '../../lib/dataset-builder.js';

export function createDatasetCommand(program: Command) {
  program
    .command('create-dataset')
    .description('Generate JSONL dataset from training examples')
    .option('-d, --data-dir <path>', 'Data directory', './training-data')
    .option('-o, --output <path>', 'Output JSONL file path')
    .option('-q, --min-quality <number>', 'Minimum quality threshold', '0.5')
    .option('-t, --max-tokens <number>', 'Maximum tokens per example', '4000')
    .option('--no-thinking', 'Exclude thinking blocks from dataset')
    .option('--validate', 'Validate JSONL format after creation')
    .action(async (options) => {
      try {
        const minQuality = parseFloat(options.minQuality);
        if (isNaN(minQuality) || minQuality < 0 || minQuality > 1) {
          elizaLogger.error('Error: Min quality must be a number between 0 and 1');
          process.exit(1);
        }

        const maxTokens = parseInt(options.maxTokens, 10);
        if (isNaN(maxTokens) || maxTokens < 100) {
          elizaLogger.error('Error: Max tokens must be a number >= 100');
          process.exit(1);
        }

        const builder = new DatasetBuilder(options.dataDir);
        await builder.loadExamples();

        const stats = builder.getStats();
        elizaLogger.info(`📊 Loaded ${stats.totalExamples} examples`);
        elizaLogger.info(`📊 Average quality: ${stats.averageQuality.toFixed(2)}`);

        if (stats.totalExamples === 0) {
          elizaLogger.error('❌ No training examples found. Add some examples first.');
          process.exit(1);
        }

        const outputPath = await builder.generateJSONL({
          includeThinking: options.thinking,
          minQuality,
          maxTokens,
          outputPath: options.output,
        });

        elizaLogger.info(`✅ Created dataset: ${outputPath}`);

        if (options.validate) {
          elizaLogger.info('🔍 Validating JSONL format...');
          const validation = await builder.validateJSONL(outputPath);

          if (validation.valid) {
            elizaLogger.info('✅ JSONL format is valid');
          } else {
            elizaLogger.info('❌ JSONL validation failed:');
            validation.errors.forEach((error) => elizaLogger.info(`  - ${error}`));
            process.exit(1);
          }
        }
      } catch (error) {
        elizaLogger.error(
          '❌ Error creating dataset:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}
