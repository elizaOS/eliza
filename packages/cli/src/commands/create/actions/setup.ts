import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import {
  ensureElizaDir,
  promptAndStorePostgresUrl,
  promptAndStoreOpenAIKey,
  promptAndStoreAnthropicKey,
  promptAndStoreOllamaConfig,
  promptAndStoreOllamaEmbeddingConfig,
  promptAndStoreGoogleKey,
  promptAndStoreOpenRouterKey,
  setupPgLite,
  installPlugin,
} from '@/src/utils';
import { execa } from 'execa';

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

      case 'openrouter': {
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
          content += '# OpenRouter Configuration\n';
          content += 'OPENROUTER_API_KEY=your_openrouter_api_key_here\n';
          content += '# Get your API key from: https://openrouter.ai/keys\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] OpenRouter placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for OpenRouter API key
          await promptAndStoreOpenRouterKey(envFilePath);
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
 * Checks if an environment variable has a real value (not a placeholder) in the content
 */
function hasValidApiKey(content: string, keyName: string): boolean {
  const regex = new RegExp(`^${keyName}=(.+)$`, 'm');
  const match = content.match(regex);
  if (!match) return false;

  const value = match[1].trim();
  // Check if it's not empty and not a placeholder
  return (
    value !== '' &&
    !value.includes('your_') &&
    !value.includes('_here') &&
    !value.includes('PLACEHOLDER') &&
    !value.includes('placeholder')
  );
}

/**
 * Sets up embedding model configuration when the primary AI model doesn't support embeddings.
 */
export async function setupEmbeddingModelConfig(
  embeddingModel: string,
  envFilePath: string,
  isNonInteractive = false
): Promise<void> {
  try {
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    if (content && !content.endsWith('\n')) {
      content += '\n';
    }

    switch (embeddingModel) {
      case 'local': {
        content += '\n# Embedding Model Configuration (Fallback)\n';
        content += '# Using local embeddings - no additional configuration needed\n';
        await fs.writeFile(envFilePath, content, 'utf8');
        console.info('[√] Using Local embeddings - no additional configuration needed');
        break;
      }

      case 'openai': {
        // Check if OpenAI key already exists with a valid value
        if (!hasValidApiKey(content, 'OPENAI_API_KEY')) {
          if (isNonInteractive) {
            // In non-interactive mode, add/update placeholder
            if (!content.includes('OPENAI_API_KEY=')) {
              content += '\n# Embedding Model Configuration (Fallback)\n';
              content += '# OpenAI Embeddings Configuration\n';
              content += 'OPENAI_API_KEY=your_openai_api_key_here\n';
              content += '# Get your API key from: https://platform.openai.com/api-keys\n';
            }
            await fs.writeFile(envFilePath, content, 'utf8');
            console.info('[√] OpenAI embeddings placeholder configuration added to .env file');
          } else {
            // Interactive mode - prompt for OpenAI API key
            console.info('\n[!] OpenAI API key is required for embeddings');
            await promptAndStoreOpenAIKey(envFilePath);
          }
        } else {
          console.info('[√] OpenAI API key already configured - will use for embeddings');
        }
        break;
      }

      case 'ollama': {
        // Check if Ollama config already exists with valid values
        if (!hasValidApiKey(content, 'OLLAMA_API_ENDPOINT')) {
          if (isNonInteractive) {
            // In non-interactive mode, add/update placeholder
            if (!content.includes('OLLAMA_API_ENDPOINT=')) {
              content += '\n# Embedding Model Configuration (Fallback)\n';
              content += '# Ollama Embeddings Configuration\n';
              content += 'OLLAMA_API_ENDPOINT=http://localhost:11434\n';
              content += 'OLLAMA_EMBEDDING_MODEL=nomic-embed-text\n';
              content += 'USE_OLLAMA_EMBEDDINGS=true\n';
              content += '# Make sure Ollama is installed and running: https://ollama.ai/\n';
            }
            await fs.writeFile(envFilePath, content, 'utf8');
            console.info('[√] Ollama embeddings placeholder configuration added to .env file');
          } else {
            // Interactive mode - prompt for Ollama embedding model configuration
            console.info('\n[!] Ollama embedding model configuration is required');
            await promptAndStoreOllamaEmbeddingConfig(envFilePath);
          }
        } else {
          // Ollama endpoint exists, but we need to prompt for embedding model specifically
          if (isNonInteractive) {
            // In non-interactive mode, just add embedding model if not present
            if (!content.includes('OLLAMA_EMBEDDING_MODEL')) {
              content += 'OLLAMA_EMBEDDING_MODEL=nomic-embed-text\n';
            }
            if (!content.includes('USE_OLLAMA_EMBEDDINGS')) {
              content += 'USE_OLLAMA_EMBEDDINGS=true\n';
            }
            await fs.writeFile(envFilePath, content, 'utf8');
            console.info('[√] Ollama embedding model configuration added to .env file');
          } else {
            // Interactive mode - always prompt for embedding model selection
            console.info('\n[!] Please select an Ollama embedding model');
            await promptAndStoreOllamaEmbeddingConfig(envFilePath);
          }
        }
        break;
      }

      case 'google': {
        // Check if Google API key already exists with a valid value
        if (!hasValidApiKey(content, 'GOOGLE_GENERATIVE_AI_API_KEY')) {
          if (isNonInteractive) {
            // In non-interactive mode, add/update placeholder
            if (!content.includes('GOOGLE_GENERATIVE_AI_API_KEY=')) {
              content += '\n# Embedding Model Configuration (Fallback)\n';
              content += '# Google Generative AI Embeddings Configuration\n';
              content += 'GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key_here\n';
              content += '# Get your API key from: https://aistudio.google.com/apikey\n';
            }
            await fs.writeFile(envFilePath, content, 'utf8');
            console.info('[√] Google embeddings placeholder configuration added to .env file');
          } else {
            // Interactive mode - prompt for Google API key
            console.info('\n[!] Google Generative AI API key is required for embeddings');
            await promptAndStoreGoogleKey(envFilePath);
          }
        } else {
          console.info('[√] Google API key already configured - will use for embeddings');
        }
        break;
      }

      default:
        console.warn(`Unknown embedding model: ${embeddingModel}, skipping configuration`);
        return;
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to set up embedding model configuration: ${errorMessage}`);
  }
}

/**
 * Resolves AI model name to plugin name
 */
function resolveModelToPlugin(modelName: string): string | null {
  const modelToPlugin: Record<string, string> = {
    openai: 'openai',
    claude: 'anthropic',
    anthropic: 'anthropic',
    openrouter: 'openrouter',
    ollama: 'ollama',
    google: 'google',
  };

  return modelToPlugin[modelName] || null;
}

/**
 * Helper function to install a model plugin with error handling
 */
async function installModelPlugin(
  modelName: string,
  targetDir: string,
  purpose: string = ''
): Promise<void> {
  const pluginName = resolveModelToPlugin(modelName);
  if (!pluginName) {
    console.warn(`⚠️  Unknown model: ${modelName}, skipping plugin installation`);
    return;
  }

  const purposeText = purpose ? ` ${purpose}` : '';

  try {
    console.info(`\n📦 Installing ${pluginName} plugin${purposeText}...`);
    await installPlugin(pluginName, targetDir);
    console.info(`✅ Installed plugin successfully!`);
  } catch (error) {
    console.warn(
      `⚠️  Could not install plugin automatically: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    console.info(`💡 You can install it manually with: elizaos plugins add ${pluginName}`);
  }
}

/**
 * Installs dependencies for the specified target directory.
 *
 * note: cleanup on ctrl-c is handled by the calling function (creators.ts)
 * we use stdio: 'inherit' here so the user sees the install progress in real-time
 */
export async function installDependencies(targetDir: string): Promise<void> {
  // Skip dependency installation in CI/test environments to save memory and time
  if (process.env.CI === 'true' || process.env.ELIZA_TEST_MODE === 'true') {
    console.info('Skipping dependency installation in CI/test environment...');
    return;
  }

  console.info('Installing dependencies...');

  // run bun install and let it inherit our stdio so user sees progress
  const subprocess = await execa('bun', ['install'], {
    cwd: targetDir,
    stdio: 'inherit',
    reject: false,
  });

  // Handle various signal termination scenarios:
  // - exitCode can be null/undefined when process is killed by signal
  // - exitCode >= 128 indicates signal termination (128 + signal number)
  // - Common codes: 130 (SIGINT), 143 (SIGTERM), 137 (SIGKILL)
  const exitCode = subprocess.exitCode;
  const isSignalTermination = exitCode == null || exitCode >= 128;

  if (exitCode !== 0 && !isSignalTermination) {
    throw new Error(`Dependency installation failed with exit code ${exitCode}`);
  }
}

/**
 * Sets up the project environment including database and AI model configuration.
 */
export async function setupProjectEnvironment(
  targetDir: string,
  database: string,
  aiModel: string,
  embeddingModel?: string,
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

  // Set up embedding model configuration if needed
  if (embeddingModel) {
    await setupEmbeddingModelConfig(embeddingModel, envFilePath, isNonInteractive);
  }

  // Install AI model plugin (skip for local AI)
  if (aiModel !== 'local') {
    await installModelPlugin(aiModel, targetDir);
  }

  // Install embedding model plugin if different from AI model
  if (embeddingModel && embeddingModel !== 'local') {
    // Compare resolved plugin names to avoid duplicate installations
    const aiPluginName = resolveModelToPlugin(aiModel);
    const embeddingPluginName = resolveModelToPlugin(embeddingModel);

    if (embeddingPluginName && embeddingPluginName !== aiPluginName) {
      await installModelPlugin(embeddingModel, targetDir, 'for embeddings');
    }
  }
}
