#!/usr/bin/env node
/**
 * Registry tool
 * Manages environment variables and state in a JSON file
 * Converted from tools/registry/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { program } from 'commander';

/**
 * Registry class for managing environment state
 */
export class EnvRegistry {
  private envFile: string;
  private data: Record<string, any> = {};

  constructor(envFile?: string) {
    this.envFile = envFile || process.env.SWE_AGENT_ENV_FILE || path.join(os.homedir(), '.swe-agent-env');
    this.loadData();
  }

  private loadData(): void {
    if (fs.existsSync(this.envFile)) {
      try {
        const content = fs.readFileSync(this.envFile, 'utf-8');
        this.data = JSON.parse(content);
      } catch (error) {
        console.error(`Error reading registry file: ${error}`);
        this.data = {};
      }
    } else {
      this.data = {};
    }
  }

  private saveData(): void {
    try {
      const dir = path.dirname(this.envFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.envFile, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error(`Error writing registry file: ${error}`);
    }
  }

  get(key: string, defaultValue: unknown = '', fallbackToEnv: boolean = true): unknown {
    if (this.data.hasOwnProperty(key)) {
      return this.data[key];
    }
    
    if (fallbackToEnv && process.env[key]) {
      return process.env[key];
    }
    
    return defaultValue;
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.saveData();
  }

  delete(key: string): void {
    delete this.data[key];
    this.saveData();
  }

  getAll(): Record<string, any> {
    return { ...this.data };
  }
}

// Global registry instance
export const registry = new EnvRegistry();

// CLI setup
function setupCLI() {
  program
    .name('registry')
    .description('Environment registry management')
    .version('1.0.0');

  program
    .command('get <key>')
    .description('Get a value from the registry')
    .option('-d, --default <value>', 'Default value if key not found')
    .action((key, options) => {
      const value = registry.get(key, options.default || '');
      console.log(value);
    });

  program
    .command('set <key> <value>')
    .description('Set a value in the registry')
    .action((key, value) => {
      registry.set(key, value);
      console.log(`Set ${key} = ${value}`);
    });

  program
    .command('delete <key>')
    .description('Delete a key from the registry')
    .action((key) => {
      registry.delete(key);
      console.log(`Deleted ${key}`);
    });

  program
    .command('list')
    .description('List all registry entries')
    .action(() => {
      const all = registry.getAll();
      console.log(JSON.stringify(all, null, 2));
    });

  program.parse(process.argv);
}

// Run CLI if called directly or from bin script
if (require.main === module || require.main?.filename?.endsWith('/bin/registry')) {
  setupCLI();
}
