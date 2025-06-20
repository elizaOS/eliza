import { describe, it, expect } from 'bun:test';
import { createUniqueUuid, formatEntities } from '../entities';
import { stringToUuid } from '../utils';

describe('entities extra', () => {
  it('createUniqueUuid combines user and agent ids', () => {
    const runtime = { agentId: 'agent' } as any;
    const id = createUniqueUuid(runtime, 'user');
    const expected = stringToUuid('user:agent');
    expect(id).toBe(expected);
  });

  it('formatEntities outputs joined string', () => {
    const entities = [
      { id: '1', names: ['A'], metadata: {} },
      { id: '2', names: ['B'], metadata: { extra: true } },
    ] as any;
    const text = formatEntities({ entities });
    expect(text).toContain('"A"');
    expect(text).toContain('ID: 1');
    expect(text).toContain('ID: 2');
  });
});
