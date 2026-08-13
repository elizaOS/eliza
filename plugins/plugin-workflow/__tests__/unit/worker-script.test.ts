/** Pins the isolated worker's smthrs import, progress protocol, and elizaOS AgentLike bridge. */
import { describe, expect, test } from 'bun:test';
import {
  createSmithersControlScript,
  createSmithersWorkerScript,
} from '../../src/services/smithers-runtime';

describe('Smithers worker script', () => {
  test('uses smthrs directly and routes agent generation to its parent', () => {
    const source = createSmithersWorkerScript();
    expect(source).toContain("from 'smthrs'");
    expect(source).toContain('__elizaSmithers');
    expect(source).toContain("kind: 'agent-request'");
    expect(source).toContain('onProgress');
    expect(source).toContain('Invalid elizaOS model response');
    expect(source).not.toContain('catch {}');
    expect(source).not.toContain('@smithers-orchestrator');
    expect(source).not.toContain('Gateway');
  });

  test('uses the public smthrs API for durable controls', () => {
    const source = createSmithersControlScript();
    expect(source).toContain("from 'smthrs'");
    expect(source).toContain("from 'smthrs/openSmithersStore'");
    expect(source).not.toContain('@smthrs/engine');
    expect(source).not.toContain('@smithers-orchestrator');
    expect(source).not.toContain('Gateway');
  });
});
