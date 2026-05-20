/**
 * defineSystem — functional definer for FeedSystem (UnJS-style).
 */

import type { FeedSystem, SystemTickResult } from './types';

export type SystemDefinition = Omit<
  FeedSystem,
  'register' | 'onTick' | 'destroy'
> & {
  register?: FeedSystem['register'];
  onTick: FeedSystem['onTick'];
  destroy?: FeedSystem['destroy'];
};

export function defineSystem(def: SystemDefinition): FeedSystem {
  return def;
}

/**
 * @deprecated Use `defineSystem()` instead.
 */
export abstract class AbstractFeedSystem implements FeedSystem {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly phase: FeedSystem['phase'];

  readonly dependencies?: string[];
  readonly skipDeadlineCheck?: boolean;
  readonly intervals?: FeedSystem['intervals'];

  async register(
    _ctx: Parameters<NonNullable<FeedSystem['register']>>[0]
  ): Promise<void> {}

  abstract onTick(
    ctx: Parameters<FeedSystem['onTick']>[0]
  ): Promise<SystemTickResult>;

  async destroy(): Promise<void> {}
}
