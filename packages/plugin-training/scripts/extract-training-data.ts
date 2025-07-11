#!/usr/bin/env node

/**
 * CLI script to extract training data from ElizaOS database
 */

import { Command } from 'commander';
import { TrainingService } from '../src/services/training-service.js';
import { type TrainingConfig } from '../src/types.js';
import { createMockRuntime } from '../src/__tests__/test-utils.js';

const program = new Command();

program
  .name('extract-training-data')
  .description('Extract training data from ElizaOS conversations')
  .version('1.0.0')
  .option('-d, --days <days>', 'Number of days to look back', '30')
  .option('-q, --quality <quality>', 'Minimum quality threshold (0-1)', '0.5')
  .option('-f, --format <format>', 'Output format (jsonl|csv|parquet)', 'jsonl')
  .option('-o, --output <path>', 'Output directory path', './training-data')
  .option('--include-actions', 'Include action metadata', false)
  .option('--include-providers', 'Include provider metadata', false)
  .option('--include-evaluators', 'Include evaluator metadata', false)
  .option('--deduplicate', 'Remove duplicate conversations', true)
  .option('--min-length <length>', 'Minimum conversation length', '3')
  .option('--max-length <length>', 'Maximum conversation length', '100')
  .parse();

const options = program.opts();

async function main() {
  console.log('🚀 ElizaOS Training Data Extraction');
  console.log('=====================================');

  try {
    // Create mock runtime for CLI usage
    const runtime = createMockRuntime();

    // Initialize training service
    const trainingService = new TrainingService(runtime);
    await trainingService.initialize();

    // Build configuration from CLI options
    const config: TrainingConfig = {
      extractionConfig: {
        startDate: new Date(Date.now() - parseInt(options.days) * 24 * 60 * 60 * 1000),
        minConversationLength: parseInt(options.minLength),
        maxConversationLength: parseInt(options.maxLength),
        includeActions: options.includeActions,
        includeProviders: options.includeProviders,
        includeEvaluators: options.includeEvaluators,
      },
      datasetConfig: {
        outputFormat: options.format,
        splitRatio: { train: 0.8, validation: 0.1, test: 0.1 },
        deduplicate: options.deduplicate,
        minQuality: parseFloat(options.quality),
        maxTokens: 512,
      },
      rlaifConfig: {
        judgeModel: 'gpt-4',
        preferenceDescription: 'helpful, harmless, and honest responses',
        maxResponseVariants: 3,
        scoringStrategy: 'pairwise',
        rewardThreshold: 0.7,
      },
      atroposConfig: {
        apiUrl: 'http://localhost:8000',
        environment: 'rlaif',
        batchSize: 4,
        maxSteps: 1000,
        learningRate: 1e-5,
        warmupSteps: 100,
        evalSteps: 50,
        saveSteps: 100,
      },
    };

    console.log('📊 Extraction Configuration:');
    console.log(`- Date range: Last ${options.days} days`);
    console.log(`- Quality threshold: ${options.quality}`);
    console.log(`- Output format: ${options.format}`);
    console.log(`- Include actions: ${options.includeActions}`);
    console.log(`- Include providers: ${options.includeProviders}`);
    console.log(`- Include evaluators: ${options.includeEvaluators}`);
    console.log(`- Deduplicate: ${options.deduplicate}`);
    console.log('');

    // Extract training data
    console.log('🔍 Extracting conversations...');
    const conversations = await trainingService.extractTrainingData(config);
    console.log(`✅ Extracted ${conversations.length} conversations`);

    // Process dataset
    console.log('⚙️ Processing dataset...');
    const datasetPath = await trainingService.prepareDataset(conversations, config);
    console.log(`✅ Dataset prepared at: ${datasetPath}`);

    // Get statistics
    console.log('📈 Generating statistics...');
    const stats = await trainingService.getTrainingStats();

    // Display results
    console.log('');
    console.log('🎯 **Extraction Results**');
    console.log('========================');
    console.log(`📁 Dataset Location: ${datasetPath}`);
    console.log(`📊 Total Conversations: ${stats.totalConversations}`);
    console.log(`💬 Total Messages: ${stats.totalMessages}`);
    console.log(
      `📏 Avg Conversation Length: ${stats.averageConversationLength.toFixed(1)} messages`
    );
    console.log(`📝 Avg Message Length: ${stats.averageMessageLength.toFixed(1)} characters`);
    console.log(`👥 Unique Participants: ${stats.participantCount}`);
    console.log(`⏰ Time Span: ${stats.timeSpan.durationDays} days`);
    console.log(`⭐ Average Quality: ${stats.qualityMetrics.averageQuality.toFixed(2)}`);
    console.log(
      `🎯 Successful Actions: ${stats.actionStats.successfulActions}/${stats.actionStats.totalActions}`
    );
    console.log('');

    // Action distribution
    if (Object.keys(stats.actionStats.actionTypes).length > 0) {
      console.log('🔧 **Action Distribution:**');
      Object.entries(stats.actionStats.actionTypes)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .forEach(([action, count]) => {
          console.log(`   ${action}: ${count}`);
        });
      console.log('');
    }

    // Topic distribution
    if (Object.keys(stats.topicDistribution).length > 0) {
      console.log('📚 **Topic Distribution:**');
      Object.entries(stats.topicDistribution)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .forEach(([topic, count]) => {
          console.log(`   ${topic}: ${count}`);
        });
      console.log('');
    }

    console.log('✨ **Next Steps:**');
    console.log('1. Review the dataset quality and statistics');
    console.log('2. Start RLAIF training: npm run train');
    console.log('3. Upload to Hugging Face: npm run upload-hf');
    console.log('4. Deploy to cloud: npm run deploy');
    console.log('');
    console.log('🎉 Training data extraction completed successfully!');
  } catch (error) {
    console.error('❌ Error during extraction:', (error as Error).message);
    console.error('');
    console.error('💡 Troubleshooting:');
    console.error('- Check database connection');
    console.error('- Verify environment variables');
    console.error('- Ensure training plugin is properly configured');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };
