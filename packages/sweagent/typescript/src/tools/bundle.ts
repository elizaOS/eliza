/**
 * Tool bundle configuration
 * Converted from sweagent/tools/bundle.py
 */

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { Command } from './commands';

/**
 * Bundle configuration
 */
export interface BundleConfig {
  tools: Record<string, any>;
  stateCommand?: string | null;
}

/**
 * Tool bundle
 */
export class Bundle {
  path: string;
  hiddenTools: string[];
  private _config?: BundleConfig;

  constructor(config: { path: string; hiddenTools?: string[] }) {
    this.path = config.path;
    this.hiddenTools = config.hiddenTools || [];
    this.validateTools();
  }

  private validateTools(): void {
    // Validate that the bundle path exists
    if (!fs.existsSync(this.path)) {
      throw new Error(`Bundle path does not exist: ${this.path}`);
    }

    // Load and validate config
    const configPath = path.join(this.path, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Bundle config not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, 'utf-8');
    this._config = yaml.load(configContent) as BundleConfig;

    // Validate tools
    if (!this._config.tools || typeof this._config.tools !== 'object') {
      throw new Error('Bundle config must contain tools object');
    }
  }

  get stateCommand(): string | null | undefined {
    return this.config.stateCommand;
  }

  get config(): BundleConfig {
    if (!this._config) {
      this.validateTools();
    }
    return this._config!;
  }

  get commands(): Command[] {
    const commands: Command[] = [];

    for (const [name, toolConfig] of Object.entries(this.config.tools)) {
      if (this.hiddenTools.includes(name)) {
        continue;
      }

      // Convert tool config to Command
      const command = new Command({
        name,
        docstring: toolConfig.docstring || null,
        signature: toolConfig.signature || null,
        endName: toolConfig.end_name || null,
        arguments: toolConfig.arguments || [],
      });

      commands.push(command);
    }

    return commands;
  }
}
