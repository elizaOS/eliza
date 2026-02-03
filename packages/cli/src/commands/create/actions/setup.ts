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
  promptAndStoreElizaCloudKey,
  setupPgLite,
} from '@/src/utils';
import { installPluginWithSpinner } from '@/src/utils/spinner-utils';

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
      case 'elizacloud': {
        // Configure elizaOS Cloud for multi-model AI
        if (isNonInteractive) {
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# elizaOS Cloud Configuration\n';
          content += '# Get your API key by running: elizaos login\n';
          content += '# Or visit: https://www.elizacloud.ai/dashboard/api-keys\n';
          content += 'ELIZAOS_API_KEY=your_elizaos_api_key_here\n';
          content +=
            '# Available models: gpt-4o-mini, gpt-4o, claude-3-5-sonnet, gemini-2.0-flash\n';
          content += '# ELIZAOS_CLOUD_SMALL_MODEL=gpt-4o-mini\n';
          content += '# ELIZAOS_CLOUD_LARGE_MODEL=gpt-4o\n';

          await fs.writeFile(envFilePath, content, 'utf8');
        } else {
          // Interactive mode - prompt for elizaOS Cloud API key or login
          await promptAndStoreElizaCloudKey(envFilePath);
        }
        break;
      }

      case 'local': {
        // Configure Ollama for local AI usage
        if (isNonInteractive) {
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# Local AI Configuration (using Ollama)\n';
          content += 'OLLAMA_API_ENDPOINT=http://localhost:11434\n';
          content += 'OLLAMA_MODEL=gemma3\n';
          content += 'OLLAMA_EMBEDDING_MODEL=nomic-embed-text\n';
          content += 'USE_OLLAMA_TEXT_MODELS=true\n';
          content += '# Make sure Ollama is installed and running: https://ollama.ai/\n';
          content += '# Pull models with: ollama pull gemma3 && ollama pull nomic-embed-text\n';

          await fs.writeFile(envFilePath, content, 'utf8');
        } else {
          // Interactive mode - prompt for Ollama configuration
          await promptAndStoreOllamaConfig(envFilePath);
          // Also set up embedding model
          await promptAndStoreOllamaEmbeddingConfig(envFilePath);
        }
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
        } else {
          // Interactive mode - prompt for OpenRouter API key
          await promptAndStoreOpenRouterKey(envFilePath);
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
export function hasValidApiKey(content: string, keyName: string): boolean {
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
        // 'local' means Ollama for embeddings, so configure it properly
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
          } else {
            // Interactive mode - prompt for Ollama embedding model configuration
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
          } else {
            // Interactive mode - always prompt for embedding model selection
            await promptAndStoreOllamaEmbeddingConfig(envFilePath);
          }
        }
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
          } else {
            // Interactive mode - prompt for OpenAI API key
            await promptAndStoreOpenAIKey(envFilePath);
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
          } else {
            // Interactive mode - prompt for Google API key
            await promptAndStoreGoogleKey(envFilePath);
          }
        }
        break;
      }

      case 'openrouter': {
        // 'openrouter' for embeddings, configure it with model and dimensions
        if (!hasValidApiKey(content, 'OPENROUTER_API_KEY')) {
          if (isNonInteractive) {
            // In non-interactive mode, add/update placeholder
            if (!content.includes('OPENROUTER_API_KEY=')) {
              content += '\n# Embedding Model Configuration (Fallback)\n';
              content += '# OpenRouter Embeddings Configuration\n';
              content += 'OPENROUTER_API_KEY=your_openrouter_api_key_here\n';
              content += 'OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small\n';
              content += 'OPENROUTER_EMBEDDING_DIMENSIONS=1536\n';
              content += '# Get your API key from: https://openrouter.ai/keys\n';
            }
            await fs.writeFile(envFilePath, content, 'utf8');
          } else {
            // Interactive mode - prompt for OpenRouter API key
            await promptAndStoreOpenRouterKey(envFilePath);
          }
        } else {
          // OpenRouter API key exists, but we need to add embedding model configuration
          if (isNonInteractive) {
            // Re-read content to get latest state
            content = await fs.readFile(envFilePath, 'utf8');

            // In non-interactive mode, just add embedding model if not present
            // Check for active (non-commented) lines only
            const hasActiveEmbeddingModel = /^OPENROUTER_EMBEDDING_MODEL=.+$/m.test(content);
            const hasActiveEmbeddingDimensions = /^OPENROUTER_EMBEDDING_DIMENSIONS=.+$/m.test(
              content
            );

            if (!hasActiveEmbeddingModel) {
              content += 'OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small\n';
            }
            if (!hasActiveEmbeddingDimensions) {
              content += 'OPENROUTER_EMBEDDING_DIMENSIONS=1536\n';
            }
            await fs.writeFile(envFilePath, content, 'utf8');
          } else {
            // Interactive mode - Re-read and add embedding config
            content = await fs.readFile(envFilePath, 'utf8');

            // Check for active (non-commented) lines only
            const hasActiveEmbeddingModel = /^OPENROUTER_EMBEDDING_MODEL=.+$/m.test(content);
            const hasActiveEmbeddingDimensions = /^OPENROUTER_EMBEDDING_DIMENSIONS=.+$/m.test(
              content
            );

            if (!hasActiveEmbeddingModel) {
              if (content && !content.endsWith('\n')) {
                content += '\n';
              }
              content += 'OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small\n';
            }
            if (!hasActiveEmbeddingDimensions) {
              if (content && !content.endsWith('\n')) {
                content += '\n';
              }
              content += 'OPENROUTER_EMBEDDING_DIMENSIONS=1536\n';
            }
            await fs.writeFile(envFilePath, content, 'utf8');
          }
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
    elizacloud: 'elizacloud', // elizaOS Cloud multi-model AI plugin
    openai: 'openai',
    claude: 'anthropic',
    anthropic: 'anthropic',
    openrouter: 'openrouter',
    local: 'ollama', // 'local' maps to ollama plugin
    google: 'google-genai',
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
    return;
  }

  await installPluginWithSpinner(pluginName, targetDir, purpose);
}

// installDependencies is now imported from spinner-utils and handles this automatically

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
  if (database === 'postgres') {
    // PostgreSQL configuration is handled before spinner tasks in interactive mode
    // Skip configuration here when called from spinner tasks (isNonInteractive=true)
    if (!isNonInteractive) {
      await promptAndStorePostgresUrl(envFilePath);
    }
  } else if (database === 'pglite') {
    await setupPgLite(undefined, `${targetDir}/.env`, targetDir);
  }

  // Set up AI model configuration (skip if non-interactive, handled before spinner tasks)
  if (!isNonInteractive) {
    await setupAIModelConfig(aiModel, envFilePath, isNonInteractive);

    // Set up embedding model configuration if needed
    if (embeddingModel) {
      await setupEmbeddingModelConfig(embeddingModel, envFilePath, isNonInteractive);
    }
  }

  // Install AI model plugin
  await installModelPlugin(aiModel, targetDir, aiModel === 'local' ? 'for local AI' : '');

  // Install embedding model plugin if different from AI model
  if (embeddingModel && embeddingModel !== 'local') {
    // Compare resolved plugin names to avoid duplicate installations
    const aiPluginName = resolveModelToPlugin(aiModel);
    const embeddingPluginName = resolveModelToPlugin(embeddingModel);

    if (embeddingPluginName && embeddingPluginName !== aiPluginName) {
      await installModelPlugin(embeddingModel, targetDir, 'for embeddings');
    }
  } else if (embeddingModel === 'local') {
    // If embedding model is 'local' (Ollama) and AI model isn't already 'local'
    if (aiModel !== 'local') {
      await installModelPlugin(embeddingModel, targetDir, 'for embeddings');
    }
  }

  // Always install Ollama plugin as fallback if not already installed
  // This is required because the default Eliza character always includes it
  // Skip for elizaOS Cloud since it provides all functionality including embeddings
  if (aiModel !== 'local' && aiModel !== 'elizacloud' && embeddingModel !== 'local') {
    await installPluginWithSpinner('ollama', targetDir, 'as universal fallback');
  }
}
