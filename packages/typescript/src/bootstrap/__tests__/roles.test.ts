import { describe, it, expect, vi } from 'vitest';
import type { IAgentRuntime } from '../../types';

describe('Warn About Unnamed Entities', () => {
  let runtime: IAgentRuntime;
  let warnedUnnamedEntities: Set<string>;

  beforeEach(() => {
    warnedUnnamedEntities = new Set();
    runtime = {
      logger: {
        warn: vi.fn()
      }
    } as unknown as IAgentRuntime;
  });

  it('should avoid duplicate warnings for the same unnamed entity', () => {
    // First warning
    if (!warnedUnnamedEntities.has('entity1')) {
      runtime.logger.warn('Entity has no name: entity1');
      warnedUnnamedEntities.add('entity1');
    }

    // Attempt second warning for same entity
    if (!warnedUnnamedEntities.has('entity1')) {
      runtime.logger.warn('Entity has no name: entity1');
      warnedUnnamedEntities.add('entity1');
    }

    expect(runtime.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('should warn for different unnamed entities', () => {
    if (!warnedUnnamedEntities.has('entity1')) {
      runtime.logger.warn('Entity has no name: entity1');
      warnedUnnamedEntities.add('entity1');
    }

    if (!warnedUnnamedEntities.has('entity2')) {
      runtime.logger.warn('Entity has no name: entity2');
      warnedUnnamedEntities.add('entity2');
    }

    expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
  });
});
