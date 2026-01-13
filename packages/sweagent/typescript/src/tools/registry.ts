/**
 * Registry module for managing environment state
 * Placeholder implementation - actual registry is in tools package
 */

import * as fs from 'fs';

export class EnvRegistry {
  private data: Record<string, any> = {};
  private envFile: string | undefined;

  constructor() {
    this.data = {};
    this.envFile = process.env.SWE_AGENT_ENV_FILE;
    this.load();
  }

  private load(): void {
    if (this.envFile && fs.existsSync(this.envFile)) {
      try {
        const content = fs.readFileSync(this.envFile, 'utf-8');
        this.data = JSON.parse(content);
      } catch (error) {
        // If parsing fails, start with empty data
        this.data = {};
      }
    }
  }

  private save(): void {
    if (this.envFile) {
      try {
        fs.writeFileSync(this.envFile, JSON.stringify(this.data, null, 2));
      } catch (error) {
        // Ignore save errors
      }
    }
  }

  get(key: string): any {
    // Reload from file to get latest data
    this.load();
    return this.data[key];
  }

  set(key: string, value: any): void {
    this.data[key] = value;
    this.save();
  }

  has(key: string): boolean {
    this.load();
    return key in this.data;
  }

  delete(key: string): void {
    delete this.data[key];
    this.save();
  }

  clear(): void {
    this.data = {};
    this.save();
  }
}

export const registry = new EnvRegistry();
