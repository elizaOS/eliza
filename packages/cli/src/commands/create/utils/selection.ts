import * as clack from '@clack/prompts';
import type { AIModelOption, DatabaseOption } from '../types';

/**
 * Returns a list of available databases for project initialization without requiring external API calls.
 */
export async function getLocalAvailableDatabases(): Promise<string[]> {
  // Hard-coded list of available databases to avoid GitHub API calls
  return [
    'pglite',
    'postgres',
    // "pglite",
    // "supabase"
  ];
}

/**
 * Gets available AI models for selection during project creation.
 */
export function getAvailableAIModels(): AIModelOption[] {
  return [
    {
      title: 'Local AI (free to use, no API key required)',
      value: 'local',
      description:
        'Use local AI models without external API requirements. Will download model to run locally.',
    },
    {
      title: 'OpenAI (ChatGPT)',
      value: 'openai',
      description: 'Use OpenAI models like GPT-4',
    },
    {
      title: 'Anthropic (Claude)',
      value: 'claude',
      description: 'Use Anthropic Claude models',
    },
    {
      title: 'Ollama (self-hosted, free to use)',
      value: 'ollama',
      description: 'Use self-hosted Ollama models for complete privacy and control',
    },
  ];
}

/**
 * Gets available database options for selection during project creation.
 */
export function getAvailableDatabases(): DatabaseOption[] {
  return [
    {
      title: 'Pglite (Pglite) - Recommended for development',
      value: 'pglite',
      description:
        'Fast, file-based database. Perfect for development and single-user deployments.',
    },
    {
      title: 'PostgreSQL - Recommended for production',
      value: 'postgres',
      description:
        'Full-featured database with vector search. Best for production and multi-user systems.',
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
