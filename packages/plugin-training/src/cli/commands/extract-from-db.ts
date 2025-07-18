import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { DatabaseExtractor } from '../../lib/database-extractor.js';
import { DatasetBuilder } from '../../lib/dataset-builder.js';
import { createMockRuntime } from './db-runtime-factory.js';

export function extractFromDbCommand(program: Command) {
  program
    .command('extract-from-db')
    .description('Extract training data from ElizaOS database')
    .option('-d, --data-dir <path>', 'Data directory', './training-data')
    .option('-t, --type <type>', 'Extraction type (plugins|code|all)', 'all')
    .option('-q, --min-quality <number>', 'Minimum quality threshold', '0.7')
    .option('-l, --limit <number>', 'Maximum examples to extract', '100')
    .option('--append', 'Append to existing examples instead of replacing')
    .action(async (options) => {
      try {
        elizaLogger.info('🔍 Connecting to ElizaOS database...');

        // Create runtime connection to database
        const runtime = await createMockRuntime();

        elizaLogger.info('📊 Extracting training data from database...');

        const extractor = new DatabaseExtractor(runtime as any);
        const builder = new DatasetBuilder(options.dataDir);

        // Load existing examples if appending
        if (options.append) {
          await builder.loadExamples();
          elizaLogger.info(`📋 Loaded ${builder.listExamples().length} existing examples`);
        }

        let extractedExamples: any[] = [];

        // Extract based on type
        switch (options.type) {
          case 'plugins':
            elizaLogger.info('🔌 Extracting plugin creation examples...');
            extractedExamples = await extractor.extractPluginCreations();
            break;
          case 'code':
            elizaLogger.info('💻 Extracting code completion examples...');
            extractedExamples = await extractor.extractCodeCompletions();
            break;
          case 'all':
          default:
            elizaLogger.info('🌟 Extracting all successful interactions...');
            extractedExamples = await extractor.extractAllSuccessfulInteractions();
            break;
        }

        // Filter by quality and limit
        const minQuality = parseFloat(options.minQuality);
        const limit = parseInt(options.limit, 10);

        const filteredExamples = extractedExamples
          .filter((example) => example.quality >= minQuality)
          .sort((a, b) => b.quality - a.quality)
          .slice(0, limit);

        elizaLogger.info(
          `📋 Filtered to ${filteredExamples.length} high-quality examples (quality >= ${minQuality})`
        );

        // Add to dataset
        for (const example of filteredExamples) {
          await builder.addExample({
            input: example.request,
            output: example.response,
            request: example.request,
            response: example.response,
            thinking: example.thinking,
            quality: example.quality,
          });
        }

        // Show statistics
        const stats = builder.getStats();
        elizaLogger.info('\\n📊 Final Dataset Statistics:');
        elizaLogger.info(`  Total examples: ${stats.totalExamples}`);
        elizaLogger.info(`  Average quality: ${stats.averageQuality.toFixed(2)}`);
        elizaLogger.info(`  Estimated tokens: ${stats.tokenCount}`);

        elizaLogger.info('\\n✅ Database extraction completed!');
        elizaLogger.info('💡 Next steps:');
        elizaLogger.info('  1. Review examples: eliza-training list-examples');
        elizaLogger.info('  2. Generate dataset: eliza-training create-dataset --validate');
        elizaLogger.info(
          '  3. Train model: eliza-training train-model --model "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B"'
        );
      } catch (error) {
        elizaLogger.error(
          '❌ Error extracting from database:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}
