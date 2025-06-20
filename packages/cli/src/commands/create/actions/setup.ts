import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import {
  ensureElizaDir,
  promptAndStorePostgresUrl,
  promptAndStoreOpenAIKey,
  promptAndStoreAnthropicKey,
  promptAndStoreOllamaConfig,
  promptAndStoreGoogleKey,
  runBunCommand,
  setupPgLite,
} from '@/src/utils';

/**
 * Creates necessary project directories.
 */
export async function createProjectDirectories(targetDir: string): Promise<void> {
  await ensureElizaDir(targetDir);
}

/**
 * Sets up AI model configuration in the project's .env file based on user selection.
 */
export async function setupAIModelConfig(
  aiModel: string,
  envFilePath: string,
  isNonInteractive = false
): Promise<void> {
  try {
    switch (aiModel) {
      case 'local': {
        console.info('[√] Using Local AI - no additional configuration needed');
        break;
      }

      case 'openai': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# OpenAI Configuration\n';
          content += 'OPENAI_API_KEY=your_openai_api_key_here\n';
          content += '# Get your API key from: https://platform.openai.com/api-keys\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] OpenAI placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for OpenAI API key
          await promptAndStoreOpenAIKey(envFilePath);
        }
        break;
      }

      case 'claude': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# Anthropic API Configuration\n';
          content += 'ANTHROPIC_API_KEY=your_anthropic_api_key_here\n';
          content += '# Get your API key from: https://console.anthropic.com/\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] Anthropic API placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for Anthropic API key
          await promptAndStoreAnthropicKey(envFilePath);
        }
        break;
      }

      case 'ollama': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# Ollama Configuration\n';
          content += 'OLLAMA_API_ENDPOINT=http://localhost:11434\n';
          content += 'OLLAMA_MODEL=llama2\n';
          content += 'USE_OLLAMA_TEXT_MODELS=true\n';
          content += '# Make sure Ollama is installed and running: https://ollama.ai/\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] Ollama placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for Ollama configuration
          await promptAndStoreOllamaConfig(envFilePath);
        }
        break;
      }

      case 'google': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# Google Generative AI Configuration\n';
          content += 'GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key_here\n';
          content += '# Get your API key from: https://aistudio.google.com/apikey\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] Google Generative AI placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for Google API key
          await promptAndStoreGoogleKey(envFilePath);
        }
        break;
      }

      default:
        console.warn(`Unknown AI model: ${aiModel}, skipping configuration`);
        return;
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to set up AI model configuration: ${errorMessage}`);
  }
}

/**
 * Installs dependencies for the specified target directory.
 */
export async function installDependencies(targetDir: string): Promise<void> {
  // Skip dependency installation in CI/test environments to save memory and time
  if (process.env.CI === 'true' || process.env.ELIZA_TEST_MODE === 'true') {
    console.info('Skipping dependency installation in CI/test environment...');
    return;
  }

  console.info('Installing dependencies...');
  await runBunCommand(['install'], targetDir);
}

/**
 * Sets up the project environment including database and AI model configuration.
 */
export async function setupProjectEnvironment(
  targetDir: string,
  database: string,
  aiModel: string,
  isNonInteractive = false
): Promise<void> {
  // Create project directories first
  await createProjectDirectories(targetDir);

  // Set up database configuration
  const envFilePath = `${targetDir}/.env`;
  if (database === 'postgres' && !isNonInteractive) {
    await promptAndStorePostgresUrl(envFilePath);
  } else if (database === 'pglite') {
    await setupPgLite(undefined, `${targetDir}/.env`, targetDir);
  }

  // Set up AI model configuration
  await setupAIModelConfig(aiModel, envFilePath, isNonInteractive);
}
