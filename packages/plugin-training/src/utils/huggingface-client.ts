import { type IAgentRuntime, elizaLogger } from '@elizaos/core';
import { type TrainingConfig } from '../types.js';
import { getTrainingConfig } from '../config/training-config.js';
import {
  whoAmI,
  createRepo,
  uploadFile,
  downloadFile,
  listDatasets,
  listFiles,
  checkRepoAccess,
  listModels,
  type Credentials,
  type RepoDesignation,
} from '@huggingface/hub';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Client for interacting with Hugging Face Hub
 */
export class HuggingFaceClient {
  private credentials: Credentials | null = null;
  private token: string | null = null;

  constructor(private runtime: IAgentRuntime) {
    this.token = this.runtime.getSetting('HUGGING_FACE_TOKEN') as string;
  }

  async initialize(): Promise<void> {
    elizaLogger.info('Initializing Hugging Face Client');

    this.token = this.runtime.getSetting('HUGGING_FACE_TOKEN') as string;

    if (!this.token) {
      elizaLogger.warn(
        'HUGGING_FACE_TOKEN not configured - Hugging Face features will be disabled'
      );
      return;
    }

    try {
      // Initialize HuggingFace credentials
      this.credentials = { accessToken: this.token };

      // Test authentication
      await this.testAuthentication();

      elizaLogger.info('Hugging Face Client initialized successfully');
    } catch (error) {
      elizaLogger.error('Error initializing Hugging Face Client:', error);
      throw error;
    }
  }

  private async testAuthentication(): Promise<void> {
    if (!this.credentials) {
      throw new Error('Hugging Face credentials not initialized');
    }

    try {
      // Try to get user info to test authentication
      const userInfo = await whoAmI({ credentials: this.credentials });
      elizaLogger.info(
        `Authenticated as Hugging Face user: ${userInfo.name || userInfo.id || 'Unknown'}`
      );
    } catch (error) {
      elizaLogger.warn(
        `HuggingFace authentication test failed: ${error instanceof Error ? error.message : String(error)}`
      );
      // Don't throw here - allow initialization to proceed as the token might still be valid for other operations
    }
  }

  /**
   * Upload dataset to Hugging Face Hub
   */
  async uploadDataset(datasetPath: string, config: TrainingConfig): Promise<string> {
    if (!config.huggingFaceConfig) {
      throw new Error('Hugging Face configuration not provided');
    }

    if (!this.credentials) {
      throw new Error('Hugging Face credentials not initialized');
    }

    elizaLogger.info(`Uploading dataset to Hugging Face: ${config.huggingFaceConfig.datasetName}`);

    try {
      const { organization, datasetName, private: isPrivate, license } = config.huggingFaceConfig;

      // Create repository name
      const repoId = organization ? `${organization}/${datasetName}` : datasetName;

      // Create repository if it doesn't exist
      await this.createRepositoryIfNotExists(repoId, isPrivate, 'dataset');

      // Upload dataset files
      await this.uploadDatasetFiles(repoId, datasetPath);

      // Create and upload README
      await this.createAndUploadReadme(repoId, config, datasetPath);

      // Create and upload dataset card
      await this.createAndUploadDatasetCard(repoId, config, datasetPath);

      const datasetUrl = `https://huggingface.co/datasets/${repoId}`;
      elizaLogger.info(`Dataset uploaded successfully: ${datasetUrl}`);

      return datasetUrl;
    } catch (error) {
      elizaLogger.error('Error uploading dataset to Hugging Face:', error);
      throw error;
    }
  }

  private async createRepositoryIfNotExists(
    repoId: string,
    isPrivate: boolean,
    repoType: 'model' | 'dataset' | 'space'
  ): Promise<void> {
    try {
      // Check if repository exists
      await checkRepoAccess({
        repo: { type: repoType, name: repoId },
        credentials: this.credentials!,
      });
      elizaLogger.info(`Repository ${repoId} already exists`);
    } catch (error) {
      if ((error as any)?.statusCode === 404) {
        // Repository doesn't exist, create it
        elizaLogger.info(`Creating repository: ${repoId}`);

        await createRepo({
          repo: { type: repoType, name: repoId },
          private: isPrivate,
          credentials: this.credentials!,
        });

        elizaLogger.info(`Repository created: ${repoId}`);
      } else {
        throw error;
      }
    }
  }

  private async uploadDatasetFiles(repoId: string, datasetPath: string): Promise<void> {
    elizaLogger.info(`Uploading files from ${datasetPath}`);

    const files = await fs.readdir(datasetPath);

    for (const filename of files) {
      const filePath = path.join(datasetPath, filename);
      const fileStat = await fs.stat(filePath);

      if (fileStat.isFile()) {
        elizaLogger.info(`Uploading file: ${filename}`);

        const fileContent = await fs.readFile(filePath);

        await uploadFile({
          repo: { type: 'dataset', name: repoId },
          file: {
            path: filename,
            content: new Blob([fileContent]),
          },
          commitTitle: `Upload ${filename}`,
          credentials: this.credentials!,
        });

        elizaLogger.info(`File uploaded: ${filename}`);
      }
    }
  }

  private async createAndUploadReadme(
    repoId: string,
    config: TrainingConfig,
    datasetPath: string
  ): Promise<void> {
    elizaLogger.info('Creating and uploading README');

    // Read metadata if it exists
    let metadata: any = {};
    try {
      const metadataPath = path.join(datasetPath, 'metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(metadataContent);
    } catch (error) {
      elizaLogger.warn('Could not read metadata file');
    }

    const readme = this.generateReadme(config, metadata);

    await uploadFile({
      repo: { type: 'dataset', name: repoId },
      file: {
        path: 'README.md',

        content: new Blob([new TextEncoder().encode(readme)]),
      },
      commitTitle: 'Add README',
      credentials: this.credentials!,
    });

    elizaLogger.info('README uploaded');
  }

  private generateReadme(config: TrainingConfig, metadata: any): string {
    const stats = metadata.statistics || {};

    return `---
license: ${config.huggingFaceConfig?.license || 'apache-2.0'}
language:
- en
tags:
- eliza
- rlaif
- training
- conversational-ai
- agent
size_categories:
- ${this.getSizeCategory(stats.total_trajectories || 0)}
task_categories:
- conversational
- text-generation
---

# ${config.huggingFaceConfig?.organization ? `${config.huggingFaceConfig.organization}/${config.huggingFaceConfig.datasetName}` : config.huggingFaceConfig?.datasetName || 'ElizaOS Training Dataset'}

This dataset contains training trajectories extracted from ElizaOS agent conversations, prepared for RLAIF (Reinforcement Learning from AI Feedback) training.

## Dataset Description

${metadata.dataset_info?.description || 'Training dataset for ElizaOS conversational agents.'}

${stats.totalConversations ? `This dataset contains **${stats.totalConversations} conversations** with **${stats.totalMessages || 'many'} messages** extracted from ElizaOS agent interactions.` : ''}

### Dataset Statistics

- **Total Trajectories**: ${stats.total_trajectories || 'N/A'}
- **Training Set**: ${stats.train_size || 'N/A'} samples
- **Validation Set**: ${stats.validation_size || 'N/A'} samples
- **Test Set**: ${stats.test_size || 'N/A'} samples

### Domain Distribution

${this.formatDistribution(stats.domains)}

### Task Type Distribution

${this.formatDistribution(stats.task_type_distribution)}

### Difficulty Distribution

${this.formatDistribution(stats.difficulty_distribution)}

## Data Format

The dataset is provided in ${config.datasetConfig.outputFormat.toUpperCase()} format with the following structure:

- \`train.${config.datasetConfig.outputFormat}\`: Training set
- \`validation.${config.datasetConfig.outputFormat}\`: Validation set  
- \`test.${config.datasetConfig.outputFormat}\`: Test set
- \`metadata.json\`: Dataset metadata and statistics

### Data Fields

Each trajectory contains:

- \`id\`: Unique identifier
- \`prompt\`: User input/question
- \`responses\`: Array of possible responses
- \`scores\`: RLAIF scores for each response
- \`metadata\`: Additional context (domain, difficulty, task type, etc.)

## Intended Use

This dataset is designed for:

- Training conversational AI agents
- RLAIF (Reinforcement Learning from AI Feedback) research
- Fine-tuning language models for agent interactions
- Evaluating conversational AI quality

## Extraction Configuration

The dataset was extracted with the following configuration:

\`\`\`json
${JSON.stringify(config.extractionConfig, null, 2)}
\`\`\`

## Processing Configuration

\`\`\`json
${JSON.stringify(config.datasetConfig, null, 2)}
\`\`\`

## RLAIF Configuration

\`\`\`json
${JSON.stringify(config.rlaifConfig, null, 2)}
\`\`\`

## Usage Example

\`\`\`python
from datasets import load_dataset

# Load the dataset
dataset = load_dataset("${config.huggingFaceConfig?.organization || 'elizaos'}/${config.huggingFaceConfig?.datasetName}")

# Access training data
train_data = dataset['train']
print(f"Training samples: {len(train_data)}")

# Example trajectory
trajectory = train_data[0]
print(f"Prompt: {trajectory['prompt']}")
print(f"Responses: {trajectory['responses']}")
\`\`\`

## Citation

If you use this dataset in your research, please cite:

\`\`\`bibtex
@dataset{elizaos_training_dataset,
  title={ElizaOS Training Dataset},
  author={ElizaOS Team},
  year={${new Date().getFullYear()}},
  url={https://huggingface.co/datasets/${config.huggingFaceConfig?.organization || 'elizaos'}/${config.huggingFaceConfig?.datasetName}},
  note={Training trajectories for RLAIF from ElizaOS agent conversations}
}
\`\`\`

## License

This dataset is released under the ${config.huggingFaceConfig?.license || 'Apache 2.0'} license.

## Contact

For questions or issues with this dataset, please contact the ElizaOS team.
`;
  }

  private getSizeCategory(count: number): string {
    if (count < 1000) {
      return 'n<1K';
    }
    if (count < 10000) {
      return '1K<n<10K';
    }
    if (count < 100000) {
      return '10K<n<100K';
    }
    if (count < 1000000) {
      return '100K<n<1M';
    }
    return 'n>1M';
  }

  private formatDistribution(distribution: Record<string, number> | undefined): string {
    if (!distribution) {
      return 'N/A';
    }

    return Object.entries(distribution)
      .sort(([, a], [, b]) => b - a)
      .map(([key, value]) => `- **${key}**: ${value}`)
      .join('\n');
  }

  private async createAndUploadDatasetCard(
    repoId: string,
    config: TrainingConfig,
    datasetPath: string
  ): Promise<void> {
    elizaLogger.info('Creating and uploading dataset card');

    const datasetCard = {
      dataset_info: {
        features: [
          { name: 'id', dtype: 'string' },
          { name: 'prompt', dtype: 'string' },
          { name: 'responses', dtype: 'string' },
          { name: 'scores', dtype: 'string' },
          { name: 'metadata', dtype: 'string' },
        ],
        splits: [{ name: 'train' }, { name: 'validation' }, { name: 'test' }],
        download_size: await this.calculateDatasetSize(datasetPath),
        dataset_size: await this.calculateDatasetSize(datasetPath),
      },
      config: {
        extraction: config.extractionConfig,
        dataset: config.datasetConfig,
        rlaif: config.rlaifConfig,
      },
    };

    await uploadFile({
      repo: { type: 'dataset', name: repoId },
      file: {
        path: 'dataset_info.json',

        content: new Blob([new TextEncoder().encode(JSON.stringify(datasetCard, null, 2))]),
      },
      commitTitle: 'Add dataset card',
      credentials: this.credentials!,
    });

    elizaLogger.info('Dataset card uploaded');
  }

  private async calculateDatasetSize(datasetPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const files = await fs.readdir(datasetPath);

      for (const filename of files) {
        const filePath = path.join(datasetPath, filename);
        const fileStat = await fs.stat(filePath);

        if (fileStat.isFile()) {
          totalSize += fileStat.size;
        }
      }
    } catch (error) {
      elizaLogger.warn('Error calculating dataset size:', error);
    }

    return totalSize;
  }

  /**
   * Download dataset from Hugging Face Hub
   */
  async downloadDataset(datasetName: string, targetPath: string): Promise<string> {
    if (!this.credentials) {
      throw new Error('Hugging Face API not initialized');
    }

    elizaLogger.info(`Downloading dataset: ${datasetName}`);

    try {
      // Create target directory
      await fs.mkdir(targetPath, { recursive: true });

      // List all files in the dataset
      const filesGenerator = listFiles({
        repo: { type: 'dataset', name: datasetName },
        credentials: this.credentials,
      });

      // Download all files
      for await (const file of filesGenerator) {
        if (file.type === 'file') {
          elizaLogger.info(`Downloading file: ${file.path}`);

          const fileContent = await downloadFile({
            repo: { type: 'dataset', name: datasetName },
            path: file.path,
            credentials: this.credentials,
          });

          const targetFilePath = path.join(targetPath, file.path);

          // Create directory if it doesn't exist
          const targetDir = path.dirname(targetFilePath);
          await fs.mkdir(targetDir, { recursive: true });

          // Convert blob to buffer and write
          const buffer = Buffer.from(await fileContent!.arrayBuffer());
          await fs.writeFile(targetFilePath, buffer);
        }
      }

      elizaLogger.info(`Dataset downloaded to: ${targetPath}`);
      return targetPath;
    } catch (error) {
      elizaLogger.error('Error downloading dataset from Hugging Face:', error);
      throw error;
    }
  }

  /**
   * List available datasets
   */
  async listDatasets(organization?: string): Promise<any[]> {
    if (!this.credentials) {
      throw new Error('Hugging Face credentials not initialized');
    }

    try {
      const datasets = await listDatasets({
        search: organization ? { owner: organization } : undefined,
        credentials: this.credentials,
      });

      // Convert async generator to array
      const result = [];
      for await (const dataset of datasets) {
        result.push(dataset);
      }
      return result;
    } catch (error) {
      elizaLogger.error('Error listing datasets:', error);
      throw error;
    }
  }

  /**
   * Create model repository for fine-tuned models
   */
  async createModelRepository(modelName: string, isPrivate: boolean = false): Promise<string> {
    if (!this.credentials) {
      throw new Error('Hugging Face credentials not initialized');
    }

    try {
      await this.createRepositoryIfNotExists(modelName, isPrivate, 'model');

      const modelUrl = `https://huggingface.co/${modelName}`;
      elizaLogger.info(`Model repository created: ${modelUrl}`);

      return modelUrl;
    } catch (error) {
      elizaLogger.error('Error creating model repository:', error);
      throw error;
    }
  }

  /**
   * Upload model to Hugging Face Hub
   */
  async uploadModel(modelPath: string, config: TrainingConfig): Promise<string> {
    if (!this.credentials) {
      throw new Error('Hugging Face API not initialized');
    }

    if (!config.huggingFaceConfig) {
      throw new Error('Hugging Face configuration not provided');
    }

    elizaLogger.info(`Uploading model to Hugging Face: ${config.huggingFaceConfig.modelName}`);

    try {
      const { organization, modelName, private: isPrivate } = config.huggingFaceConfig;

      // Create repository name
      const repoId = organization ? `${organization}/${modelName}` : modelName;

      // Create repository if it doesn't exist
      await this.createRepositoryIfNotExists(repoId, isPrivate, 'model');

      // Upload model files
      await this.uploadModelFiles(repoId, modelPath);

      // Create and upload model card
      await this.createAndUploadModelCard(repoId, config, modelPath);

      const modelUrl = `https://huggingface.co/${repoId}`;
      elizaLogger.info(`Model uploaded successfully: ${modelUrl}`);

      return modelUrl;
    } catch (error) {
      elizaLogger.error('Error uploading model to Hugging Face:', error);
      throw error;
    }
  }

  private async uploadModelFiles(repoId: string, modelPath: string): Promise<void> {
    elizaLogger.info(`Uploading model files from ${modelPath}`);

    const files = await fs.readdir(modelPath);

    for (const filename of files) {
      const filePath = path.join(modelPath, filename);
      const fileStat = await fs.stat(filePath);

      if (fileStat.isFile()) {
        elizaLogger.info(`Uploading model file: ${filename}`);

        const fileContent = await fs.readFile(filePath);

        await uploadFile({
          repo: { type: 'model', name: repoId },
          file: {
            path: filename,
            content: new Blob([fileContent]),
          },
          commitTitle: `Upload ${filename}`,
          credentials: this.credentials!,
        });

        elizaLogger.info(`Model file uploaded: ${filename}`);
      }
    }
  }

  private async createAndUploadModelCard(
    repoId: string,
    config: TrainingConfig,
    modelPath: string
  ): Promise<void> {
    elizaLogger.info('Creating and uploading model card');

    const modelCard = this.generateModelCard(config);

    await uploadFile({
      repo: { type: 'model', name: repoId },
      file: {
        path: 'README.md',

        content: new Blob([new TextEncoder().encode(modelCard)]),
      },
      commitTitle: 'Add model card',
      credentials: this.credentials!,
    });

    elizaLogger.info('Model card uploaded');
  }

  private generateModelCard(config: TrainingConfig): string {
    // Get model training configuration from TrainingConfigurationManager
    const trainingConfigManager = getTrainingConfig();
    const modelTrainingConfig = trainingConfigManager.getModelTrainingConfig();
    
    return `---
license: apache-2.0
base_model: ${modelTrainingConfig.defaultBaseModel}
tags:
- eliza
- conversational-ai
- fine-tuned
- agent
- training
library_name: transformers
pipeline_tag: text-generation
---

# ${config.huggingFaceConfig?.modelName || 'ElizaOS Fine-tuned Model'}

This is a fine-tuned conversational AI model based on ElizaOS training data.

## Model Description

This model has been fine-tuned for ElizaOS agent conversations using RLAIF (Reinforcement Learning from AI Feedback) training methodology.

## Training Configuration

- **Base Model**: ${modelTrainingConfig.defaultBaseModel}
- **Learning Rate**: ${modelTrainingConfig.defaultLearningRate}
- **Batch Size**: ${modelTrainingConfig.defaultBatchSize}
- **Training Steps**: Not specified

## Intended Use

This model is designed for:
- ElizaOS agent responses
- Conversational AI applications
- Research in AI alignment and RLAIF

## Usage

\`\`\`python
from transformers import AutoTokenizer, AutoModelForCausalLM

tokenizer = AutoTokenizer.from_pretrained("${config.huggingFaceConfig?.organization || 'elizaos'}/${config.huggingFaceConfig?.modelName}")
model = AutoModelForCausalLM.from_pretrained("${config.huggingFaceConfig?.organization || 'elizaos'}/${config.huggingFaceConfig?.modelName}")

inputs = tokenizer("Hello, how can I help you?", return_tensors="pt")
outputs = model.generate(**inputs, max_length=100)
response = tokenizer.decode(outputs[0], skip_special_tokens=True)
print(response)
\`\`\`

## Training Data

The model was trained on ElizaOS agent conversations with the following configuration:

\`\`\`json
${JSON.stringify(config.extractionConfig, null, 2)}
\`\`\`

## RLAIF Configuration

\`\`\`json
${JSON.stringify(config.rlaifConfig, null, 2)}
\`\`\`

## License

This model is released under the ${config.huggingFaceConfig?.license || 'Apache 2.0'} license.

## Contact

For questions or issues with this model, please contact the ElizaOS team.
`;
  }

  /**
   * List available models for an organization
   */
  async listModels(organization?: string): Promise<any[]> {
    if (!this.credentials) {
      throw new Error('Hugging Face API not initialized');
    }

    try {
      const models = await listModels({
        search: organization ? { owner: organization } : undefined,
        credentials: this.credentials,
      });

      // Convert async generator to array
      const result = [];
      for await (const model of models) {
        result.push(model);
      }
      return result;
    } catch (error) {
      elizaLogger.error('Error listing models:', error);
      throw error;
    }
  }

  /**
   * Create README content for datasets
   */
  createReadmeContent = (config: TrainingConfig, stats: any): string => {
    const metadataWithStats = { statistics: stats };
    return this.generateReadme(config, metadataWithStats);
  };
}
