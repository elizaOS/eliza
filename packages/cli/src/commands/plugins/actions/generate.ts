import { handleError } from '@/src/utils';
import { logger } from '@elizaos/core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { emoji } from '@/src/utils/emoji-handler';
import { GeneratePluginOptions, GenerationResult } from '../types';

/**
 * Generate a new plugin using AI-powered code generation
 */
export async function generatePlugin(opts: GeneratePluginOptions): Promise<void> {
  try {
    // Lazy import to avoid loading dependencies until needed
    const { PluginCreator } = await import('@/src/utils/plugin-creator.js');

    // Set API key if provided
    if (opts.apiKey) {
      process.env.ANTHROPIC_API_KEY = opts.apiKey;
    }

    // Check for API key
    if (!process.env.ANTHROPIC_API_KEY) {
      logger.error('ANTHROPIC_API_KEY is required for plugin generation.');
      console.log('\nPlease set ANTHROPIC_API_KEY environment variable or use --api-key option.');
      process.exit(1);
    }

    // Handle spec file if provided
    let spec = undefined;
    if (opts.specFile) {
      try {
        const specContent = readFileSync(opts.specFile, 'utf-8');
        spec = JSON.parse(specContent);
      } catch (error) {
        logger.error(
          `Failed to read or parse spec file: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    } else if (opts.skipPrompts) {
      logger.error('--skip-prompts requires --spec-file to be provided');
      process.exit(1);
    }

    // Create creator instance with options
    const creator = new PluginCreator({
      skipTests: opts.skipTests,
      skipValidation: opts.skipValidation,
      skipPrompts: opts.skipPrompts,
      spec: spec,
    });

    // Run generation
    console.log(`\n${emoji.rocket('Starting AI-powered plugin generation...')}\n`);
    const result: GenerationResult = await creator.create();

    if (result.success) {
      console.log(`\n${emoji.success('Plugin successfully generated!')}`);
      console.log(`   Name: ${result.pluginName}`);
      console.log(`   Location: ${result.pluginPath}`);
      console.log(`\nThe plugin has been created in your current directory.`);
      console.log(`\nNext steps:`);
      console.log(`1. cd ${path.basename(result.pluginPath ?? '')}`);
      console.log(`2. Review the generated code`);
      console.log(`3. Test the plugin: bun test`);
      console.log(`4. Add to your ElizaOS project`);
    } else {
      logger.error(`Plugin generation failed: ${result.error?.message}`);
      process.exit(1);
    }
  } catch (error) {
    handleError(error);
    process.exit(1);
  }
}
