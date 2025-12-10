import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import type { AIModelOption, DatabaseOption } from '../types';
import { type CloudModelTier, CLOUD_MODEL_TIERS } from '@/src/services';

/**
 * Returns a list of available databases for project initialization without requiring external API calls.
 */
export async function getLocalAvailableDatabases(): Promise<string[]> {
  // Hard-coded list of available databases to avoid GitHub API calls
  return ['pglite', 'postgres'];
}

/**
 * Gets available AI models for selection during project creation.
 */
export function getAvailableAIModels(): AIModelOption[] {
  return [
    {
      title: 'ElizaOS Cloud',
      value: 'elizacloud',
      description: 'No setup required',
    },
    {
      title: 'Local (Ollama)',
      value: 'local',
      description: 'Run models locally',
    },
    {
      title: 'OpenAI',
      value: 'openai',
      description: 'GPT-4o',
    },
    {
      title: 'Anthropic',
      value: 'claude',
      description: 'Claude',
    },
    {
      title: 'Google',
      value: 'google',
      description: 'Gemini',
    },
  ];
}

/**
 * Checks if the selected AI model provides its own database (no separate DB setup needed)
 */
export function providesDatabase(aiModel: string): boolean {
  // ElizaOS Cloud provides both AI and managed database
  return aiModel === 'elizacloud';
}

/**
 * Checks if an AI model has built-in embedding support.
 * Models with embeddings don't need a separate embedding provider.
 */
export function hasEmbeddingSupport(aiModel: string): boolean {
  const modelsWithEmbeddings = ['elizacloud', 'local', 'openai', 'google', 'openrouter'];
  return modelsWithEmbeddings.includes(aiModel);
}

/**
 * Gets available database options for selection during project creation.
 */
export function getAvailableDatabases(): DatabaseOption[] {
  return [
    {
      title: 'PGlite',
      value: 'pglite',
      description: 'Embedded, no setup',
    },
    {
      title: 'PostgreSQL',
      value: 'postgres',
      description: 'External database',
    },
  ];
}

/**
 * Prompts user to select a database type with interactive UI.
 */
export async function selectDatabase(): Promise<string> {
  const availableDatabases = getAvailableDatabases();

  const database = await clack.select({
    message: 'Select database:',
    options: availableDatabases.map((db) => ({
      label: db.title,
      value: db.value,
      hint: db.description,
    })),
    initialValue: 'pglite',
  });

  if (clack.isCancel(database)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  return database as string;
}

/**
 * Prompts user to select an AI model with interactive UI.
 * If elizaOS Cloud is selected, also prompts for model tier.
 */
export async function selectAIModel(): Promise<string> {
  const availableModels = getAvailableAIModels();

  const aiModel = await clack.select({
    message: 'Select AI provider:',
    options: availableModels.map((model) => ({
      label: model.title,
      value: model.value,
      hint: model.description,
    })),
    initialValue: 'elizacloud',
  });

  if (clack.isCancel(aiModel)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  // If user selected elizaOS Cloud, prompt for model tier
  if (aiModel === 'elizacloud') {
    await selectCloudModelTier();
  }

  return aiModel as string;
}

/**
 * Prompts user to select a cloud model tier (fast/pro/ultra)
 */
export async function selectCloudModelTier(): Promise<CloudModelTier> {
  const selectedTier = await clack.select({
    message: 'Select model tier:',
    options: CLOUD_MODEL_TIERS.map((tier) => ({
      label: `${tier.name} ${colors.dim(tier.priceIndicator)}`,
      value: tier.id,
      hint: tier.modelInfo,
    })),
    initialValue: 'pro' as CloudModelTier,
  });

  if (clack.isCancel(selectedTier)) {
    return 'pro';
  }

  process.env.ELIZAOS_CLOUD_MODEL_TIER = selectedTier as CloudModelTier;
  return selectedTier as CloudModelTier;
}

/**
 * Gets available embedding models for selection when primary AI model doesn't support embeddings.
 */
export function getAvailableEmbeddingModels(): AIModelOption[] {
  return [
    {
      title: 'Local (Ollama)',
      value: 'local',
      description: 'Run locally',
    },
    {
      title: 'OpenAI',
      value: 'openai',
      description: 'text-embedding-ada-002',
    },
  ];
}

/**
 * Prompts user to select an embedding model when the primary AI model doesn't support embeddings.
 */
export async function selectEmbeddingModel(): Promise<string> {
  const availableModels = getAvailableEmbeddingModels();

  const embeddingModel = await clack.select({
    message: 'Select embedding provider:',
    options: availableModels.map((model) => ({
      label: model.title,
      value: model.value,
      hint: model.description,
    })),
    initialValue: 'local',
  });

  if (clack.isCancel(embeddingModel)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  return embeddingModel as string;
}
