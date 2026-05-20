/**
 * Tick metrics accumulator.
 */

import type { TickMetrics } from './types';

export class DefaultTickMetrics implements TickMetrics {
  private readonly data = new Map<string, number | string | boolean>();
  private readonly _warnings: string[] = [];

  set(key: string, value: number | string | boolean): void {
    this.data.set(key, value);
  }

  get(key: string): number | string | boolean | undefined {
    return this.data.get(key);
  }

  increment(key: string, amount = 1): void {
    const current = this.data.get(key);
    if (current === undefined) {
      this.data.set(key, amount);
    } else if (typeof current === 'number') {
      this.data.set(key, current + amount);
    } else {
      this._warnings.push(
        `Cannot increment non-numeric metric "${key}" (current type: ${typeof current})`
      );
    }
  }

  addWarning(warning: string): void {
    this._warnings.push(warning);
  }

  warnings(): string[] {
    return [...this._warnings];
  }

  snapshot(): Record<string, number | string | boolean> {
    const result: Record<string, number | string | boolean> = {};
    for (const [key, value] of this.data) {
      result[key] = value;
    }
    return result;
  }
}
