import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { DatasetBuilder } from '../../lib/dataset-builder.js';

export function listExamplesCommand(program: Command) {
  program
    .command('list-examples')
    .description('List and manage training examples')
    .option('-d, --data-dir <path>', 'Data directory', './training-data')
    .option('--stats', 'Show statistics only')
    .option('--remove <id>', 'Remove example by ID')
    .option('-q, --min-quality <number>', 'Filter by minimum quality')
    .action(async (options) => {
      try {
        const builder = new DatasetBuilder(options.dataDir);
        await builder.loadExamples();

        if (options.remove) {
          const removed = await builder.removeExample(options.remove);
          if (removed) {
            elizaLogger.info(`✅ Removed example: ${options.remove}`);
          } else {
            elizaLogger.info(`❌ Example not found: ${options.remove}`);
            process.exit(1);
          }
          return;
        }

        const stats = builder.getStats();

        elizaLogger.info('📊 Dataset Statistics:');
        elizaLogger.info(`  Total examples: ${stats.totalExamples}`);
        elizaLogger.info(`  Average quality: ${stats.averageQuality.toFixed(2)}`);
        elizaLogger.info(`  Estimated tokens: ${stats.tokenCount.toLocaleString()}`);

        if (options.stats) {
          return;
        }

        if (stats.totalExamples === 0) {
          elizaLogger.info(
            '\n📝 No training examples found. Add some with: eliza-training add-example'
          );
          return;
        }

        let examples = builder.listExamples();

        if (options.minQuality) {
          const minQuality = parseFloat(options.minQuality);
          if (isNaN(minQuality)) {
            elizaLogger.error('❌ Error: Min quality must be a number');
            process.exit(1);
          }
          examples = examples.filter((ex) => ex.quality >= minQuality);
          elizaLogger.info(
            `\n🔍 Filtered to ${examples.length} examples with quality >= ${minQuality}`
          );
        }

        elizaLogger.info('\n📋 Training Examples:');
        elizaLogger.info('─'.repeat(80));

        examples.forEach((example, index) => {
          elizaLogger.info(`${index + 1}. ID: ${example.id}`);
          elizaLogger.info(`   Quality: ${example.quality.toFixed(2)}`);
          elizaLogger.info(`   Created: ${example.createdAt.toISOString()}`);
          elizaLogger.info(
            `   Request: ${example.request.substring(0, 100)}${example.request.length > 100 ? '...' : ''}`
          );
          elizaLogger.info(
            `   Response: ${example.response.substring(0, 100)}${example.response.length > 100 ? '...' : ''}`
          );
          if (example.thinking) {
            elizaLogger.info(
              `   Thinking: ${example.thinking.substring(0, 100)}${example.thinking.length > 100 ? '...' : ''}`
            );
          }
          elizaLogger.info('─'.repeat(80));
        });

        if (examples.length > 0) {
          elizaLogger.info('\n💡 To remove an example: eliza-training list-examples --remove <id>');
          elizaLogger.info('💡 To create a dataset: eliza-training create-dataset');
        }
      } catch (error) {
        elizaLogger.error(
          '❌ Error listing examples:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}
