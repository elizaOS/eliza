/**
 * Registry module for managing environment state
 * Placeholder implementation - actual registry is in tools package
 */

import * as fs from "node:fs";
import type { JsonObject, JsonValue } from "../json";

export class EnvRegistry {
  private data: JsonObject = {};
  private envFile: string | undefined;

  constructor() {
    this.data = {};
    this.envFile = process.env.SWE_AGENT_ENV_FILE;
    this.load();
  }

  private load(): void {
    if (this.envFile && fs.existsSync(this.envFile)) {
      try {
        const content = fs.readFileSync(this.envFile, "utf-8");
        this.data = JSON.parse(content) as JsonObject;
      } catch (_error) {
        // If parsing fails, start with empty data
        this.data = {};
      }
    }
  }

  private save(): void {
    if (this.envFile) {
      try {
        fs.writeFileSync(this.envFile, JSON.stringify(this.data, null, 2));
      } catch (_error) {
        // Ignore save errors
      }
    }
  }

  get(key: string, defaultValue?: JsonValue): JsonValue | undefined {
    // Reload from file to get latest data
    this.load();
    const value = this.data[key];
    return value === undefined ? defaultValue : value;
  }

  set(key: string, value: JsonValue): void {
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
