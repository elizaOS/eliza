#!/usr/bin/env node

/**
 * CLI script to start RLAIF training with Atropos
 */

import { Command } from 'commander';
import { TrainingService } from '../src/services/training-service.js';
import { type TrainingConfig } from '../src/types.js';
import { createMockRuntime } from '../src/__tests__/test-utils.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const program = new Command();

program
  .name('start-training')
  .description('Start RLAIF training with Atropos')
  .version('1.0.0')
  .option('-c, --config <path>', 'Training configuration file')
  .option('-d, --dataset <path>', 'Dataset directory path', './training-data')
  .option('-m, --model <model>', 'Base model name', 'deepseek-coder')
  .option('-j, --judge <judge>', 'Judge model for RLAIF', 'gpt-4')
  .option('-s, --steps <steps>', 'Training steps', '1000')
  .option('-b, --batch-size <size>', 'Batch size', '4')
  .option('-l, --learning-rate <rate>', 'Learning rate', '1e-5')
  .option('--cloud <provider>', 'Cloud provider (gcp|aws|azure)')
  .option('--instance-type <type>', 'Cloud instance type')
  .option('--gpu-type <type>', 'GPU type for training')
  .option('--upload-hf', 'Upload dataset to Hugging Face', false)
  .option('--hf-org <org>', 'Hugging Face organization', 'elizaos')
  .option('--hf-dataset <name>', 'Hugging Face dataset name')
  .option('--wandb', 'Enable Weights & Biases logging', false)
  .option('--wandb-project <project>', 'W&B project name', 'eliza-training')
  .parse();

const options = program.opts();

async function main() {
  console.log('🚀 ElizaOS RLAIF Training with Atropos');
  console.log('======================================');

  try {
    // Load configuration if provided
    let config: TrainingConfig;

    if (options.config) {
      console.log(`📄 Loading configuration from: ${options.config}`);
      const configData = await fs.readFile(options.config, 'utf-8');
      config = JSON.parse(configData);
    } else {
      // Build configuration from CLI options
      config = buildConfigFromOptions(options);
    }

    // Create mock runtime for CLI usage
    const runtime = createMockRuntime();

    // Initialize training service
    const trainingService = new TrainingService(runtime);
    await trainingService.initialize();

    // Display configuration
    displayConfiguration(config);

    // Check prerequisites
    await checkPrerequisites(config);

    // Check if dataset exists
    const datasetExists = await checkDatasetExists(options.dataset);
    if (!datasetExists) {
      console.log('📊 No dataset found. Extracting training data first...');
      const conversations = await trainingService.extractTrainingData(config);
      const datasetPath = await trainingService.prepareDataset(conversations, config);
      console.log(`✅ Dataset prepared at: ${datasetPath}`);
    }

    // Upload to Hugging Face if requested
    if (options.uploadHf && config.huggingFaceConfig) {
      console.log('📤 Uploading dataset to Hugging Face...');
      const huggingFaceUrl = await trainingService.uploadToHuggingFace(options.dataset, config);
      console.log(`✅ Dataset uploaded: ${huggingFaceUrl}`);
    }

    // Deploy to cloud if configured
    let cloudInstance = null;
    if (config.deploymentConfig) {
      console.log(`☁️ Deploying to ${config.deploymentConfig.provider.toUpperCase()}...`);
      cloudInstance = await trainingService.deployToCloud(config);
      console.log(`✅ Cloud instance created: ${cloudInstance.id}`);
      console.log(`🌐 Instance IP: ${cloudInstance.publicIp || 'Pending...'}`);
    }

    // Start training
    console.log('🎯 Starting RLAIF training...');
    const trainingJob = await trainingService.startTraining(config);

    // Display training information
    console.log('');
    console.log('🎉 **Training Started Successfully!**');
    console.log('====================================');
    console.log(`🆔 Job ID: ${trainingJob.id}`);
    console.log(`📊 Status: ${trainingJob.status}`);
    console.log(`⏰ Started: ${trainingJob.startTime?.toISOString()}`);
    console.log('');

    console.log('📋 **Configuration Summary:**');
    console.log(`🤖 Model: ${config.atroposConfig.environment}`);
    console.log(`⚖️ Judge: ${config.rlaifConfig.judgeModel}`);
    console.log(`📏 Steps: ${config.atroposConfig.maxSteps}`);
    console.log(`📦 Batch Size: ${config.atroposConfig.batchSize}`);
    console.log(`📈 Learning Rate: ${config.atroposConfig.learningRate}`);
    console.log('');

    if (cloudInstance) {
      console.log('☁️ **Cloud Deployment:**');
      console.log(`🏢 Provider: ${cloudInstance.provider.toUpperCase()}`);
      console.log(`🌍 Region: ${cloudInstance.region}`);
      console.log(`💻 Instance: ${cloudInstance.instanceType}`);
      console.log(`🖥️ Instance ID: ${cloudInstance.id}`);
      console.log('');
    }

    console.log('🔗 **Useful Commands:**');
    console.log(`📊 Monitor training: npm run monitor -- --job-id ${trainingJob.id}`);
    console.log('📈 View TensorBoard: http://localhost:6006 (if running locally)');
    console.log('🌐 Atropos API: http://localhost:8000');
    console.log('📞 Bridge WebSocket: ws://localhost:8765');
    console.log('');

    console.log('⏱️ **Monitoring:**');
    console.log('Training will proceed through the RLAIF pipeline:');
    console.log('1. 🎭 Generate response variants');
    console.log('2. ⚖️ Judge preferences with AI feedback');
    console.log('3. 🔄 Apply reinforcement learning updates');
    console.log('4. 💾 Save checkpoints and evaluate progress');
    console.log('');

    // Start monitoring if in interactive mode
    if (process.stdout.isTTY) {
      console.log('🔄 Starting live monitoring (press Ctrl+C to exit)...');
      await monitorTraining(trainingService, trainingJob.id);
    } else {
      console.log('✨ Training is running in the background!');
      console.log(`Use "npm run monitor -- --job-id ${trainingJob.id}" to check progress.`);
    }
  } catch (error) {
    console.error('❌ Error during training setup:', error.message);
    console.error('');
    console.error('💡 Troubleshooting:');
    console.error('- Check Atropos bridge is running: python3 atropos/bridge_server.py');
    console.error('- Verify API keys and configuration');
    console.error('- Ensure dataset exists or can be extracted');
    console.error('- Check cloud credentials if using cloud deployment');
    process.exit(1);
  }
}

function buildConfigFromOptions(options: any): TrainingConfig {
  const config: TrainingConfig = {
    extractionConfig: {
      includeActions: true,
      includeProviders: true,
      includeEvaluators: true,
    },
    datasetConfig: {
      outputFormat: 'jsonl',
      splitRatio: { train: 0.8, validation: 0.1, test: 0.1 },
      maxTokens: 512,
      deduplicate: true,
      minQuality: 0.7,
    },
    rlaifConfig: {
      judgeModel: options.judge,
      preferenceDescription:
        'helpful, harmless, and honest responses that demonstrate good coding practices',
      maxResponseVariants: 3,
      scoringStrategy: 'pairwise',
      rewardThreshold: 0.7,
    },
    atroposConfig: {
      apiUrl: 'http://localhost:8000',
      environment: options.model,
      batchSize: parseInt(options.batchSize),
      maxSteps: parseInt(options.steps),
      learningRate: parseFloat(options.learningRate),
      warmupSteps: Math.floor(parseInt(options.steps) * 0.1),
      evalSteps: Math.floor(parseInt(options.steps) * 0.05),
      saveSteps: Math.floor(parseInt(options.steps) * 0.1),
    },
  };

  // Add cloud deployment config
  if (options.cloud) {
    config.deploymentConfig = {
      provider: options.cloud,
      region: getDefaultRegion(options.cloud),
      instanceType: options.instanceType || getDefaultInstanceType(options.cloud),
      gpuType: options.gpuType || getDefaultGpuType(options.cloud),
      maxInstances: 1,
      autoScaling: false,
    };
  }

  // Add Hugging Face config
  if (options.uploadHf) {
    config.huggingFaceConfig = {
      organization: options.hfOrg,
      datasetName: options.hfDataset || `eliza-training-${Date.now()}`,
      modelName: `eliza-${options.model}-${Date.now()}`,
      private: false,
      license: 'apache-2.0',
    };
  }

  return config;
}

function getDefaultRegion(provider: string): string {
  switch (provider) {
    case 'gcp':
      return 'us-central1-a';
    case 'aws':
      return 'us-west-2';
    case 'azure':
      return 'eastus';
    default:
      return 'us-central1-a';
  }
}

function getDefaultInstanceType(provider: string): string {
  switch (provider) {
    case 'gcp':
      return 'n1-standard-8';
    case 'aws':
      return 'p3.2xlarge';
    case 'azure':
      return 'Standard_NC6s_v3';
    default:
      return 'n1-standard-8';
  }
}

function getDefaultGpuType(provider: string): string {
  switch (provider) {
    case 'gcp':
      return 'nvidia-tesla-v100';
    case 'aws':
      return 'nvidia-tesla-v100';
    case 'azure':
      return 'nvidia-tesla-v100';
    default:
      return 'nvidia-tesla-v100';
  }
}

function displayConfiguration(config: TrainingConfig) {
  console.log('⚙️ **Training Configuration:**');
  console.log(`🤖 Model: ${config.atroposConfig.environment}`);
  console.log(`⚖️ Judge: ${config.rlaifConfig.judgeModel}`);
  console.log(`📏 Steps: ${config.atroposConfig.maxSteps}`);
  console.log(`📦 Batch Size: ${config.atroposConfig.batchSize}`);
  console.log(`📈 Learning Rate: ${config.atroposConfig.learningRate}`);
  console.log(`🎯 Strategy: ${config.rlaifConfig.scoringStrategy}`);

  if (config.deploymentConfig) {
    console.log(`☁️ Cloud: ${config.deploymentConfig.provider.toUpperCase()}`);
    console.log(`💻 Instance: ${config.deploymentConfig.instanceType}`);
  }

  if (config.huggingFaceConfig) {
    console.log(
      `🤗 HF Dataset: ${config.huggingFaceConfig.organization}/${config.huggingFaceConfig.datasetName}`
    );
  }

  console.log('');
}

async function checkPrerequisites(config: TrainingConfig) {
  console.log('🔍 Checking prerequisites...');

  const checks = [
    {
      name: 'Atropos API',
      check: async () => {
        try {
          const response = await fetch(`${config.atroposConfig.apiUrl}/health`);
          return response.ok;
        } catch {
          return false;
        }
      },
      required: true,
    },
    {
      name: 'Python environment',
      check: async () => {
        try {
          const { spawn } = await import('child_process');
          return new Promise((resolve) => {
            const process = spawn('python3', ['--version']);
            process.on('close', (code) => resolve(code === 0));
          });
        } catch {
          return false;
        }
      },
      required: true,
    },
  ];

  for (const check of checks) {
    const result = await check.check();
    const status = result ? '✅' : check.required ? '❌' : '⚠️';
    console.log(`${status} ${check.name}`);

    if (!result && check.required) {
      throw new Error(`Required prerequisite failed: ${check.name}`);
    }
  }

  console.log('✅ Prerequisites check passed');
  console.log('');
}

async function checkDatasetExists(datasetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(datasetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function monitorTraining(trainingService: TrainingService, jobId: string) {
  const updateInterval = 10000; // 10 seconds

  while (true) {
    try {
      const job = await trainingService.monitorTraining(jobId);

      if (!job) {
        console.log('❌ Training job not found');
        break;
      }

      // Clear previous line and print status
      process.stdout.write('\r\x1b[K'); // Clear line

      const status = job.status;
      const progress = job.progress;

      if (progress) {
        const percentage = ((progress.currentStep / progress.totalSteps) * 100).toFixed(1);
        const progressBar = generateProgressBar(progress.currentStep, progress.totalSteps, 20);
        process.stdout.write(
          `🔄 ${status.toUpperCase()} ${progressBar} ${percentage}% ` +
            `(${progress.currentStep}/${progress.totalSteps}) ` +
            `Loss: ${progress.currentLoss?.toFixed(4) || 'N/A'}`
        );
      } else {
        process.stdout.write(`🔄 ${status.toUpperCase()}`);
      }

      if (status === 'completed') {
        console.log('\n🎉 Training completed successfully!');
        break;
      } else if (status === 'failed') {
        console.log('\n❌ Training failed');
        if (job.error) {
          console.log(`Error: ${job.error}`);
        }
        break;
      } else if (status === 'cancelled') {
        console.log('\n🛑 Training was cancelled');
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, updateInterval));
    } catch (error) {
      console.log('\n❌ Error monitoring training:', error.message);
      break;
    }
  }
}

function generateProgressBar(current: number, total: number, length: number = 20): string {
  if (total === 0) {
    return '░'.repeat(length);
  }

  const filled = Math.round((current / total) * length);
  const empty = length - filled;

  return '█'.repeat(filled) + '░'.repeat(empty);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };
