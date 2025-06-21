import { logger } from '@elizaos/core';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export interface EnvVarPrompt {
  name: string;
  description?: string;
  required: boolean;
  defaultValue?: string;
  sensitive?: boolean; // For API keys, tokens, etc.
}

export interface CollectedEnvVars {
  [key: string]: string;
}

/**
 * Interactive environment variable collector for migration
 */
export class EnvPrompter {
  private rl: readline.Interface | null = null;

  /**
   * Initialize readline interface
   */
  private ensureInterface(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({ 
        input, 
        output,
        terminal: true  // Ensure proper terminal handling
      });
      
      // Add error handling for the interface
      this.rl.on('error', (error) => {
        console.error('Readline interface error:', error);
      });
    }
    return this.rl;
  }

  /**
   * Clean up readline interface
   */
  private cleanup(): void {
    if (this.rl) {
      this.rl.removeAllListeners(); // Remove any event listeners
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Prompt user for multiple environment variables
   */
  async promptForEnvVars(envVars: EnvVarPrompt[]): Promise<CollectedEnvVars> {
    const collected: CollectedEnvVars = {};

    if (envVars.length === 0) {
      logger.info('ℹ️  No environment variables required for this plugin');
      return collected;
    }

    try {
      console.log('🔧 Environment Variable Configuration');
      console.log('═'.repeat(50));
      console.log('Please provide the following values (press Enter to skip optional fields):\n');

      for (const envVar of envVars) {
        try {
          const value = await this.promptForSingleVar(envVar);
          if (value) {
            collected[envVar.name] = value;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(`❌ Error collecting ${envVar.name}: ${errorMessage}`);
          if (envVar.required) {
            throw new Error(`Required environment variable ${envVar.name} could not be collected`);
          }
        }
      }

      console.log(`✅ Environment variable collection complete! Collected ${Object.keys(collected).length} variables.\n`);
      return collected;
    } catch (error) {
      logger.error('Error during environment variable collection:', error);
      throw error;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Prompt for a single environment variable
   */
  private async promptForSingleVar(envVar: EnvVarPrompt): Promise<string> {
    const { name, description, required, defaultValue, sensitive } = envVar;
    const rl = this.ensureInterface();

    // Build prompt message
    let promptMessage = `📝 ${name}`;
    if (description) {
      promptMessage += ` (${description})`;
    }
    if (required) {
      promptMessage += ' [REQUIRED]';
    }
    if (defaultValue && !sensitive) {
      promptMessage += ` [default: ${defaultValue}]`;
    }
    promptMessage += ': ';

    while (true) {
      let answer = await rl.question(promptMessage);
      
      // Trim whitespace from answer
      answer = answer.trim();

      // Use default if no answer provided
      if (!answer && defaultValue) {
        answer = defaultValue;
      }

      // Validate required fields
      if (required && !answer) {
        console.log('❌ This field is required. Please provide a value.\n');
        continue;
      }

      // Show confirmation for sensitive values
      if (sensitive && answer) {
        const masked = answer.slice(0, 4) + '*'.repeat(Math.max(0, answer.length - 8)) + answer.slice(-4);
        console.log(`✅ ${name}: ${masked}\n`);
      } else if (answer) {
        console.log(`✅ ${name}: ${answer}\n`);
      } else {
        console.log(`⏭️  ${name}: (skipped)\n`);
      }

      return answer || '';
    }
  }

  /**
   * Create environment variable prompts from detected variables
   */
  static createEnvPrompts(envVarNames: string[], pluginName: string): EnvVarPrompt[] {
    return envVarNames.map(name => {
      const prompt: EnvVarPrompt = {
        name,
        required: true, // Assume required since they were detected from code
        sensitive: EnvPrompter.isSensitiveVar(name),
        description: EnvPrompter.getVarDescription(name, pluginName)
      };

      return prompt;
    });
  }

  /**
   * Check if an environment variable contains sensitive information
   */
  static isSensitiveVar(varName: string): boolean {
    const sensitivePatterns = [
      /api_key/i,
      /token/i,
      /secret/i,
      /password/i,
      /private_key/i,
      /auth/i
    ];

    return sensitivePatterns.some(pattern => pattern.test(varName));
  }

  /**
   * Generate helpful descriptions for common environment variables
   */
  private static getVarDescription(varName: string, pluginName: string): string {
    const descriptions: { [key: string]: string } = {
      'OPENAI_API_KEY': 'OpenAI API key (required for ElizaOS core functionality)',
      'API_KEY': `API key for ${pluginName} service`,
      'TOKEN': `Authentication token for ${pluginName}`,
      'SECRET': `Secret key for ${pluginName}`,
      'ENDPOINT': `API endpoint URL for ${pluginName}`,
      'URL': `Service URL for ${pluginName}`,
      'WEBHOOK_URL': `Webhook URL for ${pluginName}`,
      'CLIENT_ID': `Client ID for ${pluginName} OAuth`,
      'CLIENT_SECRET': `Client secret for ${pluginName} OAuth`,
      'DISCORD_TOKEN': 'Discord bot token',
      'DISCORD_APPLICATION_ID': 'Discord application ID',
      'TWITTER_API_KEY': 'Twitter API key',
      'TELEGRAM_BOT_TOKEN': 'Telegram bot token',
      'ANTHROPIC_API_KEY': 'Anthropic API key',
      'COINMARKETCAP_API_KEY': 'CoinMarketCap API key',
      'NEWS_API_KEY': 'News API key',
      'COINGECKO_API_KEY': 'CoinGecko API key',
      'ELEVENLABS_API_KEY': 'ElevenLabs API key',
    };

    // Try exact match first
    if (descriptions[varName]) {
      return descriptions[varName];
    }

    // Try pattern matching
    for (const [pattern, desc] of Object.entries(descriptions)) {
      if (varName.includes(pattern)) {
        return desc.replace('service', pluginName);
      }
    }

    // Default description
    return `Configuration value for ${pluginName} plugin`;
  }

  /**
   * Ask user if they want to configure environment variables now or later
   */
  static async askConfigureNow(envVars: string[] = []): Promise<boolean> {
    let rl: readline.Interface | null = null;
    
    try {
      // Clear any pending input and ensure clean terminal state
      process.stdout.write('\n');
      
      rl = readline.createInterface({ 
        input, 
        output,
        terminal: true
      });
      
      // Add error handling
      rl.on('error', (error) => {
        console.error('Error in environment variable prompt:', error);
      });
      
      console.log('🤔 Environment Variable Configuration');
      console.log('─'.repeat(40));
      console.log('This plugin requires environment variables to function.');
      
      if (envVars.length > 0) {
        console.log('\n🔧 Detected environment variables:');
        for (const envVar of envVars) {
          const isSensitive = EnvPrompter.isSensitiveVar(envVar);
          const icon = isSensitive ? '🔐' : '⚙️';
          console.log(`   ${icon} ${envVar}`);
        }
      }
      
      console.log('\nYou can:');
      console.log('  1. Configure them now (recommended)');
      console.log('  2. Skip and configure later manually\n');

      while (true) {
        const answer = await rl.question('Configure environment variables now? (y/n): ');
        const normalizedAnswer = answer.trim().toLowerCase();

        if (normalizedAnswer === 'y' || normalizedAnswer === 'yes') {
          console.log(''); // Add spacing
          return true;
        }
        if (normalizedAnswer === 'n' || normalizedAnswer === 'no') {
          console.log('\n📝 You can configure environment variables later by:');
          console.log('  1. Editing the .env file in the plugin directory');
          console.log('  2. Running elizaos test to test the plugin\n');
          return false;
        }
        console.log('Please answer y (yes) or n (no)');
      }
    } finally {
      if (rl) {
        rl.removeAllListeners();
        rl.close();
      }
    }
  }
} 