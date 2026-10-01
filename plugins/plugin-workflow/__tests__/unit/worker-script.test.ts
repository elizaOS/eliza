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
    expect(source).not.toContain('supportsNativeStructuredOutput');
    expect(source).not.toContain('Boolean(args.outputSchema)');
    expect(source).not.toContain('catch {}');
    expect(source).not.toContain('@smithers-orchestrator');
    expect(source).not.toContain('Gateway');
  });

  test('uses public Smithers control exports, including canonical subtree cancellation', () => {
    const source = createSmithersControlScript();
    expect(source).toContain("from 'smthrs'");
    expect(source).toContain("from 'smthrs/openSmithersStore'");
    // smthrs 0.35 does not re-export cancellation; this declared dependency
    // exposes the canonical helper through its public subpath export.
    expect(source).toContain("from '@smthrs/engine/cancel-subtree'");
    expect(source).not.toContain('@smthrs/engine/src/');
    expect(source).not.toContain('node_modules/');
    expect(source).not.toContain('@smithers-orchestrator');
    expect(source).not.toContain('Gateway');
  });
});
