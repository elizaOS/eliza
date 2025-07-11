import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { TrainingMonitor } from '../../lib/training-monitor.js';

const execAsync = promisify(exec);

export function trainWithMonitoringCommand(program: Command) {
  program
    .command('train-live')
    .description('Train model with live progress monitoring')
    .requiredOption('-k, --api-key <key>', 'Together.ai API key')
    .requiredOption('-f, --file <path>', 'JSONL dataset file path')
    .option(
      '-m, --model <model>',
      'Base model to fine-tune',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B'
    )
    .option('-s, --suffix <suffix>', 'Model suffix', `eliza-${Date.now()}`)
    .option('-e, --epochs <number>', 'Number of training epochs', '1')
    .option('-i, --interval <seconds>', 'Monitoring poll interval', '30')
    .option('--no-confirm', 'Skip confirmation prompts')
    .action(async (options) => {
      try {
        elizaLogger.info('🚀 Starting Training with Live Monitoring');
        elizaLogger.info('═'.repeat(50));

        const { apiKey, file: filePath, model, suffix, epochs, interval, confirm } = options;

        // Step 1: Validate dataset
        elizaLogger.info('📊 Step 1: Validating Dataset');
        elizaLogger.info('─'.repeat(30));

        await fs.access(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content
          .trim()
          .split('\n')
          .filter((line) => line.trim().length > 0);

        elizaLogger.info(`✅ Dataset validated: ${lines.length} examples`);
        elizaLogger.info(`📁 File: ${filePath}`);

        // Step 2: Upload dataset
        elizaLogger.info('\n📤 Step 2: Uploading Dataset');
        elizaLogger.info('─'.repeat(30));

        const uploadResult = await execAsync(
          `TOGETHER_API_KEY="${apiKey}" together files upload "${filePath}"`,
          { timeout: 60000 }
        );

        const uploadData = JSON.parse(uploadResult.stdout);
        const fileId = uploadData.id;

        elizaLogger.info(`✅ Upload successful: ${fileId}`);
        elizaLogger.info(`📊 File size: ${uploadData.bytes} bytes`);

        // Step 3: Start training
        elizaLogger.info('\n🎯 Step 3: Starting Training Job');
        elizaLogger.info('─'.repeat(30));

        const confirmFlag = confirm ? '--confirm' : '';
        const trainCommand = `TOGETHER_API_KEY="${apiKey}" together fine-tuning create --training-file ${fileId} --model "${model}" --suffix "${suffix}" --n-epochs ${epochs} ${confirmFlag}`;

        elizaLogger.info(`🔄 Command: ${trainCommand.replace(apiKey, 'xxx...')}`);

        const trainResult = await execAsync(trainCommand, { timeout: 60000 });

        // Extract job ID from output
        const jobIdMatch = trainResult.stdout.match(/job ([a-zA-Z0-9-]+)/);
        if (!jobIdMatch) {
          throw new Error('Could not extract job ID from training output');
        }

        const jobId = jobIdMatch[1];
        elizaLogger.info(`✅ Training started: ${jobId}`);

        // Step 4: Start live monitoring
        elizaLogger.info('\n📡 Step 4: Starting Live Monitoring');
        elizaLogger.info('─'.repeat(30));

        const monitor = new TrainingMonitor(apiKey);

        // Set up monitoring callbacks
        const monitoringOptions = {
          pollInterval: parseInt(interval, 10),
          verbose: true,

          onProgress: (progress: any) => {
            // Additional progress logging if needed
          },

          onComplete: (progress: any) => {
            elizaLogger.info('\n🎉 SUCCESS: Training completed successfully!');
            elizaLogger.info('═'.repeat(50));
            elizaLogger.info('💡 Next Steps:');
            elizaLogger.info('  1. Test the model with inference');
            elizaLogger.info('  2. Deploy for production use');
            elizaLogger.info('  3. Integrate with ElizaOS');

            if (progress.output_name) {
              elizaLogger.info(`\n🎯 Fine-tuned model: ${progress.output_name}`);
              elizaLogger.info('\n🧪 Test with:');
              elizaLogger.info(
                `   together inference ${progress.output_name} "Create a Discord plugin"`
              );
            }
          },

          onError: (error: Error) => {
            elizaLogger.error(`\n❌ Monitoring error: ${error.message}`);
            elizaLogger.info('💡 You can manually check status with:');
            elizaLogger.info(`   TOGETHER_API_KEY="xxx" together fine-tuning retrieve ${jobId}`);
          },
        };

        // Start monitoring (this will run until completion or error)
        await monitor.startMonitoring(jobId, monitoringOptions);
      } catch (error) {
        elizaLogger.error(
          '❌ Training failed:',
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof Error && error.message.includes('Aborted')) {
          elizaLogger.info(
            '\n💡 Training requires confirmation. Run with --no-confirm flag to skip prompts.'
          );
        }

        process.exit(1);
      }
    });
}

export function monitorExistingCommand(program: Command) {
  program
    .command('monitor')
    .description('Monitor an existing training job')
    .requiredOption('-k, --api-key <key>', 'Together.ai API key')
    .requiredOption('-j, --job-id <id>', 'Training job ID to monitor')
    .option('-i, --interval <seconds>', 'Monitoring poll interval', '30')
    .action(async (options) => {
      try {
        const { apiKey, jobId, interval } = options;

        elizaLogger.info(`🔍 Starting monitoring for job: ${jobId}`);
        elizaLogger.info('═'.repeat(50));

        const monitor = new TrainingMonitor(apiKey);

        const monitoringOptions = {
          pollInterval: parseInt(interval, 10),
          verbose: true,

          onComplete: (progress: any) => {
            elizaLogger.info('\n🎉 Training completed!');
            if (progress.output_name) {
              elizaLogger.info(`🎯 Model: ${progress.output_name}`);
            }
          },

          onError: (error: Error) => {
            elizaLogger.error(`❌ Error: ${error.message}`);
          },
        };

        await monitor.startMonitoring(jobId, monitoringOptions);
      } catch (error) {
        elizaLogger.error(
          '❌ Monitoring failed:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}

export function listJobsCommand(program: Command) {
  program
    .command('jobs')
    .description('List all fine-tuning jobs')
    .requiredOption('-k, --api-key <key>', 'Together.ai API key')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      try {
        const { apiKey, json } = options;

        const result = await execAsync(`TOGETHER_API_KEY="${apiKey}" together fine-tuning list`, {
          timeout: 30000,
        });

        if (json) {
          // Parse and output as JSON
          const lines = result.stdout.split('\n');
          const jobLines = lines.filter((line) => line.includes('ft-'));
          const jobs = jobLines.map((line) => {
            const parts = line.split('|').map((p) => p.trim());
            return {
              id: parts[1],
              output_name: parts[2],
              status: parts[3],
              created_at: parts[4],
              price: parts[5],
            };
          });
          elizaLogger.info(JSON.stringify(jobs, null, 2));
        } else {
          elizaLogger.info(result.stdout);
        }
      } catch (error) {
        elizaLogger.error(
          '❌ Failed to list jobs:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}
