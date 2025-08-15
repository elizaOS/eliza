import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { TogetherAIClient } from '../../lib/together-client.js';
import { bunExec } from '@elizaos/cli/src/utils/bun-exec.js';

export function trainModelCommand(program: Command) {
  program
    .command('train-model')
    .description('Start fine-tuning on Together.ai')
    .option('-k, --api-key <key>', 'Together.ai API key (or set TOGETHER_AI_API_KEY)')
    .requiredOption('-m, --model <model>', 'Base model to fine-tune')
    .requiredOption('-f, --file <path>', 'JSONL dataset file')
    .option('-s, --suffix <suffix>', 'Model suffix')
    .option('-e, --epochs <number>', 'Number of training epochs', '3')
    .option('-lr, --learning-rate <number>', 'Learning rate', '1e-5')
    .option('-b, --batch-size <number>', 'Batch size', '1')
    .option('--monitor', 'Monitor training progress')
    .action(async (options) => {
      try {
        const apiKey = options.apiKey || process.env.TOGETHER_AI_API_KEY;
        if (!apiKey) {
          elizaLogger.error(
            '❌ Error: Together.ai API key is required (use --api-key or TOGETHER_AI_API_KEY env var)'
          );
          process.exit(1);
        }

        // Validate model name
        if (!options.model || typeof options.model !== 'string' || options.model.length === 0) {
          elizaLogger.error('❌ Error: Model name is required and must be a non-empty string');
          process.exit(1);
        }

        // Validate model name doesn't contain shell metacharacters
        if (!/^[a-zA-Z0-9\-_./]+$/.test(options.model)) {
          elizaLogger.error('❌ Error: Model name contains invalid characters. Only alphanumeric, dash, underscore, dot, and slash are allowed');
          process.exit(1);
        }

        // Validate file path
        if (!options.file || typeof options.file !== 'string' || options.file.length === 0) {
          elizaLogger.error('❌ Error: Dataset file path is required and must be a non-empty string');
          process.exit(1);
        }

        // Validate numeric parameters
        const epochs = parseInt(options.epochs, 10);
        const learningRate = parseFloat(options.learningRate);
        const batchSize = parseInt(options.batchSize, 10);

        if (isNaN(epochs) || epochs < 1 || epochs > 100) {
          elizaLogger.error('❌ Error: Epochs must be a positive integer between 1 and 100');
          process.exit(1);
        }

        if (isNaN(learningRate) || learningRate <= 0 || learningRate > 1) {
          elizaLogger.error('❌ Error: Learning rate must be a positive number between 0 and 1');
          process.exit(1);
        }

        if (isNaN(batchSize) || batchSize < 1 || batchSize > 128) {
          elizaLogger.error('❌ Error: Batch size must be a positive integer between 1 and 128');
          process.exit(1);
        }

        // Validate suffix if provided
        if (options.suffix && !/^[a-zA-Z0-9\-_]+$/.test(options.suffix)) {
          elizaLogger.error('❌ Error: Model suffix contains invalid characters. Only alphanumeric, dash, and underscore are allowed');
          process.exit(1);
        }

        const _client = new TogetherAIClient(apiKey);

        elizaLogger.info('📤 Uploading dataset to Together.ai...');

        try {
          const uploadResult = await bunExec(
            'together',
            ['files', 'upload', options.file, '--purpose', 'fine-tune'],
            { 
              env: { TOGETHER_API_KEY: apiKey },
              timeout: 120000 // 2 minutes for upload
            }
          );

          if (!uploadResult.success) {
            throw new Error(`Upload failed: ${uploadResult.stderr}`);
          }

          let uploadData;
          try {
            uploadData = JSON.parse(uploadResult.stdout);
          } catch (parseError) {
            throw new Error(`Failed to parse upload response: ${uploadResult.stdout}`);
          }
          const fileId = uploadData.id;
          elizaLogger.info(`✅ Dataset uploaded: ${fileId}`);

          elizaLogger.info('🚀 Starting fine-tuning job...');

          // Use Together.ai CLI for fine-tuning since it works reliably
          const suffix = options.suffix || `eliza-${Date.now()}`;
          const fineTuneResult = await bunExec(
            'together',
            [
              'fine-tuning', 'create',
              '--training-file', fileId,
              '--model', options.model,
              '--suffix', suffix,
              '--n-epochs', epochs.toString(),
              '--learning-rate', learningRate.toString(),
              '--batch-size', batchSize.toString(),
              '--confirm'
            ],
            { 
              env: { TOGETHER_API_KEY: apiKey },
              timeout: 60000 // 1 minute for job creation
            }
          );

          if (!fineTuneResult.success) {
            throw new Error(`Fine-tuning job creation failed: ${fineTuneResult.stderr}`);
          }

          // Extract job ID from the output
          const jobIdMatch = fineTuneResult.stdout.match(/job (\S+) at/);
          if (!jobIdMatch) {
            throw new Error('Could not extract job ID from Together.ai response');
          }

          const jobId = jobIdMatch[1];
          elizaLogger.info(`✅ Fine-tuning job started: ${jobId}`);
          elizaLogger.info(`📊 Base model: ${options.model}`);
          elizaLogger.info('📊 Status: queued');

          if (options.monitor) {
            elizaLogger.info('\n🔍 Monitoring training progress...');
            await monitorJobCLI(apiKey, jobId);
          } else {
            elizaLogger.info(
              `\n💡 To monitor progress, run: eliza-training test-model --job-id ${jobId} --api-key ${apiKey}`
            );
          }
        } catch (uploadError) {
          elizaLogger.error(
            '❌ Upload failed:',
            uploadError instanceof Error ? uploadError.message : String(uploadError)
          );
          process.exit(1);
        }
      } catch (error) {
        elizaLogger.error(
          '❌ Error starting training:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}

async function monitorJobCLI(apiKey: string, jobId: string): Promise<void> {
  let lastStatus = '';

  while (true) {
    try {
      const statusResult = await bunExec(
        'together',
        ['fine-tuning', 'retrieve', jobId],
        { 
          env: { TOGETHER_API_KEY: apiKey },
          timeout: 30000 // 30 seconds timeout
        }
      );

      if (!statusResult.success) {
        throw new Error(`Status check failed: ${statusResult.stderr}`);
      }

      let jobData;
      try {
        jobData = JSON.parse(statusResult.stdout);
      } catch (parseError) {
        throw new Error(`Failed to parse job status response: ${statusResult.stdout}`);
      }

      if (jobData.status !== lastStatus) {
        elizaLogger.info(`📊 Status: ${jobData.status}`);
        lastStatus = jobData.status;

        if (jobData.status === 'completed') {
          elizaLogger.info(`🎉 Training completed! Fine-tuned model: ${jobData.output_name}`);
          break;
        } else if (jobData.status === 'failed') {
          elizaLogger.error('❌ Training failed');
          break;
        } else if (jobData.status === 'running') {
          elizaLogger.info(
            `⚡ Training progress: ${jobData.steps_completed}/${jobData.total_steps} steps`
          );
        }
      }

      // Wait 30 seconds before checking again
      await new Promise((resolve) => setTimeout(resolve, 30000));
    } catch (error) {
      elizaLogger.error(
        '❌ Error monitoring job:',
        error instanceof Error ? error.message : String(error)
      );
      break;
    }
  }
}

async function monitorJob(client: TogetherAIClient, jobId: string): Promise<void> {
  let lastStatus = '';

  while (true) {
    try {
      const job = await client.getJobStatus(jobId);

      if (job.status !== lastStatus) {
        elizaLogger.info(`📊 Status: ${job.status}`);
        lastStatus = job.status;

        if (job.error) {
          elizaLogger.info(`❌ Error: ${job.error}`);
        }

        if (job.fineTunedModel) {
          elizaLogger.info(`🎯 Fine-tuned model: ${job.fineTunedModel}`);
        }
      }

      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        if (job.status === 'succeeded') {
          elizaLogger.info('✅ Training completed successfully!');
          elizaLogger.info(`🎯 Fine-tuned model: ${job.fineTunedModel}`);
          elizaLogger.info(`📅 Finished: ${job.finishedAt?.toISOString()}`);
        } else {
          elizaLogger.info(`❌ Training ${job.status}`);
          if (job.error) {
            elizaLogger.info(`Error: ${job.error}`);
          }
        }
        break;
      }

      // Wait 30 seconds before next check
      await new Promise((resolve) => setTimeout(resolve, 30000));
    } catch (error) {
      elizaLogger.error(
        '❌ Error monitoring job:',
        error instanceof Error ? error.message : String(error)
      );
      await new Promise((resolve) => setTimeout(resolve, 60000)); // Wait longer on error
    }
  }
}
