/**
 * Simple typed DI container backed by a Map.
 */

import { FrameworkError, ServiceNotFoundError } from './errors';
import type { ServiceContainer } from './types';

export class DefaultServiceContainer implements ServiceContainer {
  private readonly services = new Map<string, unknown>();

  register<T>(token: string, instance: T): void {
    if (this.services.has(token)) {
      throw new FrameworkError(
        `Service "${token}" is already registered. ` +
          `Use a unique token or remove the existing registration first.`
      );
    }
    this.services.set(token, instance);
  }

  get<T>(token: string): T {
    if (!this.services.has(token)) {
      throw new ServiceNotFoundError(token, this.tokens());
    }
    return this.services.get(token) as T;
  }

  has(token: string): boolean {
    return this.services.has(token);
  }

  tokens(): string[] {
    return [...this.services.keys()];
  }
}
