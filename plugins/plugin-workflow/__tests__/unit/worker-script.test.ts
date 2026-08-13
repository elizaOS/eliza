/** Pins the isolated worker's smthrs import, progress protocol, and elizaOS AgentLike bridge. */
import { describe, expect, test } from 'bun:test';
import { createSmithersWorkerScript } from '../../src/services/smithers-runtime';

describe('Smithers worker script', () => {
  test('uses smthrs directly and routes agent generation to its parent', () => {
    const source = createSmithersWorkerScript();
    expect(source).toContain("from '@smthrs/engine'");
    expect(source).toContain('__elizaSmithers');
    expect(source).toContain("kind: 'agent-request'");
    expect(source).toContain('onProgress');
    expect(source).toContain('Invalid elizaOS model response');
    expect(source).not.toContain('catch {}');
    expect(source).not.toContain('@smithers-orchestrator');
    expect(source).not.toContain('Gateway');
  });
});
