/**
 * Agent Memory
 *
 * Simple in-memory storage for recent actions and context
 */

import type { JsonValue } from '@babylon/shared';

export interface MemoryEntry {
  action: string;
  params: Record<string, JsonValue>;
  result: Record<string, JsonValue>;
  timestamp: number;
}

export interface MemoryConfig {
  maxEntries: number;
}

export class AgentMemory {
  private entries: MemoryEntry[] = [];
  private config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  /**
   * Add entry to memory
   */
  add(entry: MemoryEntry): void {
    this.entries.push(entry);

    // Keep only last N entries
    if (this.entries.length > this.config.maxEntries) {
      this.entries = this.entries.slice(-this.config.maxEntries);
    }
  }

  /**
   * Get recent entries
   */
  getRecent(count: number): MemoryEntry[] {
    return this.entries.slice(-count);
  }

  /**
   * Get all entries
   */
  getAll(): MemoryEntry[] {
    return [...this.entries];
  }

  /**
   * Clear memory
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get summary for LLM context
   */
  getSummary(): string {
    if (this.entries.length === 0) {
      return 'No recent actions.';
    }

    const recent = this.getRecent(5);
    return recent
      .map((entry) => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const resultStr =
          typeof entry.result === 'string'
            ? entry.result
            : JSON.stringify(entry.result);
        return `[${time}] ${entry.action}: ${resultStr.substring(0, 100)}`;
      })
      .join('\n');
  }
}
