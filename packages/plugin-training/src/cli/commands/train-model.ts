import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { TogetherAIClient } from '../../lib/together-client.js';

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

        const epochs = parseInt(options.epochs, 10);
        const learningRate = parseFloat(options.learningRate);
        const batchSize = parseInt(options.batchSize, 10);

        if (isNaN(epochs) || epochs < 1) {
          elizaLogger.error('❌ Error: Epochs must be a positive integer');
          process.exit(1);
        }

        const _client = new TogetherAIClient(apiKey);

        elizaLogger.info('📤 Uploading dataset to Together.ai...');

        // Use Together.ai CLI for file upload since it works reliably
        const { execSync } = await import('child_process');

        try {
          const uploadResult = execSync(
            `TOGETHER_API_KEY="${apiKey}" together files upload "${options.file}" --purpose fine-tune`,
            { encoding: 'utf8' }
          );

          const uploadData = JSON.parse(uploadResult);
          const fileId = uploadData.id;
          elizaLogger.info(`✅ Dataset uploaded: ${fileId}`);

          elizaLogger.info('🚀 Starting fine-tuning job...');

          // Use Together.ai CLI for fine-tuning since it works reliably
          const suffix = options.suffix || `eliza-${Date.now()}`;
          const fineTuneResult = execSync(
            `TOGETHER_API_KEY="${apiKey}" together fine-tuning create --training-file "${fileId}" --model "${options.model}" --suffix "${suffix}" --n-epochs ${epochs} --learning-rate ${learningRate} --batch-size ${batchSize} --confirm`,
            { encoding: 'utf8' }
          );

          // Extract job ID from the output
          const jobIdMatch = fineTuneResult.match(/job (\S+) at/);
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
  const { execSync } = await import('child_process');

  while (true) {
    try {
      const statusResult = execSync(
        `TOGETHER_API_KEY="${apiKey}" together fine-tuning retrieve ${jobId}`,
        { encoding: 'utf8' }
      );

      const jobData = JSON.parse(statusResult);

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
