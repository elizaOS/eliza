import { type Plugin, elizaLogger } from '@elizaos/core';
import { TrainingService } from './services/training-service.js';
import { TogetherReasoningService } from './services/TogetherReasoningService.js';
import { trainingActions } from './actions/index.js';
import { trainingProviders } from './providers/index.js';
import { mvpCustomReasoningPlugin } from './mvp/mvp-plugin';

export * from './types.js';
export * from './services/training-service.js';
export * from './services/TogetherReasoningService.js';
export * from './actions/index.js';
export * from './providers/index.js';
export * from './utils/data-extractor.js';
export * from './utils/dataset-processor.js';
export * from './utils/huggingface-client.js';
export * from './config/training-config.js';

// Export custom reasoning interfaces and components
export * from './interfaces/CustomReasoningService.js';
export * from './lib/together-client.js';
export * from './training/DataCollector.js';

// Export MVP implementation (the working one)
export * from './mvp';

/**
 * ElizaOS Training Plugin (Complex Implementation)
 *
 * Provides comprehensive training data extraction, RLAIF training, and custom reasoning capabilities:
 * - Extract training data from ElizaOS conversations
 * - Prepare datasets for fine-tuning and RLAIF
 * - Integrate with Atropos for reinforcement learning
 * - Deploy training to cloud providers
 * - Upload datasets to Hugging Face
 * - Monitor training progress
 * - Custom reasoning with fine-tuned DeepSeek models via Together.ai
 * - ShouldRespond, Planning, and Coding model overrides
 * - Training data collection and automatic model improvement
 * - Cost management and auto-shutdown capabilities
 * - Anthropic API proxy for autocoder integration
 */
export const trainingPlugin: Plugin = {
  name: '@elizaos/plugin-training',
  description:
    'Training data extraction, RLAIF training, and custom reasoning with fine-tuned models for ElizaOS agents',

  services: [TrainingService, TogetherReasoningService as any],
  actions: trainingActions,
  providers: trainingProviders,

  init: async (config, runtime) => {
    // Log initialization
    elizaLogger.info('Initializing Training Plugin with Custom Reasoning');

    // Validate training settings
    const trainingSettings = ['HUGGING_FACE_TOKEN', 'ATROPOS_API_URL'];

    const missingTrainingSettings = trainingSettings.filter(
      (setting) => !runtime.getSetting(setting)
    );

    if (missingTrainingSettings.length > 0) {
      elizaLogger.warn(`Training features missing settings: ${missingTrainingSettings.join(', ')}`);
      elizaLogger.warn(
        'Traditional training features may be disabled without proper configuration'
      );
    }

    // Validate custom reasoning settings
    const customReasoningEnabled = runtime.getSetting('REASONING_SERVICE_ENABLED') === 'true';
    const togetherApiKey = runtime.getSetting('TOGETHER_AI_API_KEY');

    if (customReasoningEnabled) {
      if (!togetherApiKey) {
        elizaLogger.error('REASONING_SERVICE_ENABLED=true but TOGETHER_AI_API_KEY is missing');
        elizaLogger.error('Custom reasoning service will not be available');
      } else {
        elizaLogger.info('Custom reasoning service enabled with Together.ai');

        // Log which models are configured
        const modelStates = [
          {
            name: 'ShouldRespond',
            enabled: runtime.getSetting('REASONING_SERVICE_SHOULD_RESPOND_ENABLED') === 'true',
          },
          {
            name: 'Planning',
            enabled: runtime.getSetting('REASONING_SERVICE_PLANNING_ENABLED') === 'true',
          },
          {
            name: 'Coding',
            enabled: runtime.getSetting('REASONING_SERVICE_CODING_ENABLED') === 'true',
          },
        ];

        const enabledModels = modelStates.filter((m) => m.enabled);
        const disabledModels = modelStates.filter((m) => !m.enabled);

        if (enabledModels.length > 0) {
          elizaLogger.info(
            `Enabled custom reasoning models: ${enabledModels.map((m) => m.name).join(', ')}`
          );
        }
        if (disabledModels.length > 0) {
          elizaLogger.info(
            `Disabled custom reasoning models: ${disabledModels.map((m) => m.name).join(', ')}`
          );
        }

        // Log cost management settings
        const budgetLimit = runtime.getSetting('REASONING_SERVICE_BUDGET_LIMIT');
        const autoShutdown = runtime.getSetting('REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES');

        if (budgetLimit) {
          elizaLogger.info(`Custom reasoning budget limit: $${budgetLimit}`);
        }
        if (autoShutdown) {
          elizaLogger.info(`Custom reasoning auto-shutdown: ${autoShutdown} minutes`);
        }

        // Check Anthropic proxy configuration
        const proxyEnabled = runtime.getSetting('ANTHROPIC_PROXY_ENABLED') === 'true';
        const proxyPort = runtime.getSetting('ANTHROPIC_PROXY_PORT') || '8001';

        if (proxyEnabled) {
          elizaLogger.info(`Anthropic API proxy enabled on port ${proxyPort}`);
        }
      }
    } else {
      elizaLogger.info(
        'Custom reasoning service disabled (REASONING_SERVICE_ENABLED not set to true)'
      );
    }

    // Check optional cloud settings
    const cloudSettings = ['GCP_PROJECT_ID', 'AWS_KEY_NAME', 'AZURE_RESOURCE_GROUP'];

    const availableCloudProviders = cloudSettings.filter((setting) => runtime.getSetting(setting));

    if (availableCloudProviders.length > 0) {
      elizaLogger.info(`Cloud deployment available for: ${availableCloudProviders.join(', ')}`);
    }

    // Check database availability (runtime extends IDatabaseAdapter)
    try {
      await runtime.getConnection();
      elizaLogger.info('Database connection validated successfully');
    } catch (error) {
      elizaLogger.warn('Database connection not available - some training features may be limited');
      elizaLogger.warn('This is expected in test environments or when using non-SQL adapters');
      // Don't throw error for missing DB in test environments
    }

    elizaLogger.info('Training Plugin with Custom Reasoning initialized successfully');
    elizaLogger.info('Available actions: EXTRACT_TRAINING_DATA, START_TRAINING, MONITOR_TRAINING');
    elizaLogger.info('Available providers: TRAINING_STATUS');
    elizaLogger.info('Available services: TrainingService, TogetherReasoningService');

    // Log usage instructions
    elizaLogger.info(`
Training Plugin Usage:
=== Traditional Training ===
1. Extract data: "extract training data from the last 30 days"
2. Start training: "start RLAIF training with the extracted dataset"
3. Monitor: "monitor training [job-id]"
4. Cloud deploy: "launch training on Google Cloud"
5. Upload to HF: Configure HUGGING_FACE_TOKEN for dataset uploads

=== Custom Reasoning (New) ===
1. Configuration: Set REASONING_SERVICE_ENABLED=true and TOGETHER_AI_API_KEY
2. Enable models: Set REASONING_SERVICE_SHOULD_RESPOND_ENABLED=true (and planning/coding)
3. CLI commands available:
   - elizaos reasoning config (show current configuration)
   - elizaos reasoning models list (show model status)
   - elizaos reasoning data export (export training data)
   - elizaos reasoning costs report (show cost breakdown)
4. Automatic features:
   - Training data collection from agent decisions
   - Cost management and auto-shutdown
   - Model deployment via Together.ai
   - Anthropic API proxy for autocoder integration

=== Environment Variables ===
REASONING_SERVICE_ENABLED=true
TOGETHER_AI_API_KEY=your_key_here
REASONING_SERVICE_SHOULD_RESPOND_ENABLED=true
REASONING_SERVICE_PLANNING_ENABLED=true
REASONING_SERVICE_CODING_ENABLED=false
REASONING_SERVICE_BUDGET_LIMIT=100
REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES=30
ANTHROPIC_PROXY_ENABLED=false
ANTHROPIC_PROXY_PORT=8001

⚠️  WARNING: This complex implementation may not work correctly.
💡 RECOMMENDED: Use mvpCustomReasoningPlugin for a working solution.
    `);
  },
};

/**
 * MVP Custom Reasoning Plugin - Actually Working Implementation
 *
 * This is the recommended plugin that actually works.
 * Use this instead of the complex trainingPlugin above.
 */
export { mvpCustomReasoningPlugin };
