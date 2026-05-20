/**
 * Simple ID Generator for JSON Storage
 *
 * Generates unique IDs without requiring snowflake or external dependencies.
 */

export class JsonIdGenerator {
  private counters: Map<string, number> = new Map();
  private prefix: string;

  constructor(prefix = "json") {
    this.prefix = prefix;
  }

  /**
   * Generate a unique ID for a given entity type.
   */
  generate(type: string): string {
    const count = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, count);
    const timestamp = Date.now();
    return `${this.prefix}-${type}-${timestamp}-${count}`;
  }

  /**
   * Set counter for a type (for restoring state).
   */
  setCounter(type: string, value: number): void {
    this.counters.set(type, value);
  }

  /**
   * Get current counter value.
   */
  getCounter(type: string): number {
    return this.counters.get(type) ?? 0;
  }

  /**
   * Export counters for persistence.
   */
  exportCounters(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /**
   * Import counters from persistence.
   */
  importCounters(counters: Record<string, number>): void {
    for (const [key, value] of Object.entries(counters)) {
      this.counters.set(key, value);
    }
  }
}
