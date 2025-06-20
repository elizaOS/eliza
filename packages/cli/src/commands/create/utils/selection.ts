import * as clack from '@clack/prompts';
import type { AIModelOption, DatabaseOption } from '../types';

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
      title: 'Local AI',
      value: 'local',
      description: 'Local models, no API required',
    },
    {
      title: 'OpenAI',
      value: 'openai',
      description: 'GPT-4 models',
    },
    {
      title: 'Anthropic',
      value: 'claude',
      description: 'Claude models',
    },
    {
      title: 'Ollama',
      value: 'ollama',
      description: 'Self-hosted models',
    },
    {
      title: 'Google Generative AI',
      value: 'google',
      description: 'Gemini models',
    },
  ];
}

/**
 * Gets available database options for selection during project creation.
 */
export function getAvailableDatabases(): DatabaseOption[] {
  return [
    {
      title: 'Pglite (Pglite)',
      value: 'pglite',
      description: 'Local development',
    },
    {
      title: 'PostgreSQL',
      value: 'postgres',
      description: 'Production database',
    },
  ];
}

/**
 * Prompts user to select a database type with interactive UI.
 */
export async function selectDatabase(): Promise<string> {
  const availableDatabases = getAvailableDatabases();

  const database = await clack.select({
    message: 'Which database would you like to use?',
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
 */
export async function selectAIModel(): Promise<string> {
  const availableModels = getAvailableAIModels();

  const aiModel = await clack.select({
    message: 'Which AI model would you like to use?',
    options: availableModels.map((model) => ({
      label: model.title,
      value: model.value,
      hint: model.description,
    })),
    initialValue: 'local',
  });

  if (clack.isCancel(aiModel)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  return aiModel as string;
}
