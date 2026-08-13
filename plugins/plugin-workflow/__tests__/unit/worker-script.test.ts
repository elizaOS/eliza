/** Pins public smthrs imports, the worker protocol, and dependency ownership. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSmithersControlScript,
  createSmithersWorkerScript,
} from '../../src/services/smithers-runtime';

const pluginRoot = join(import.meta.dir, '../..');

describe('Smithers worker script', () => {
  test('uses the public smthrs facade and routes generation to its parent', () => {
    const source = createSmithersWorkerScript();
    expect(source).toContain("import { runWorkflow } from 'smthrs'");
    expect(source).not.toContain("runWorkflow } from '@smthrs/engine'");
    expect(source).toContain('__elizaSmithers');
    expect(source).toContain("kind: 'agent-request'");
    expect(source).toContain('onProgress');
    expect(source).toContain('Invalid elizaOS model response');
    expect(source).not.toContain('catch {}');
    expect(source).not.toContain('@smithers-orchestrator');
    expect(source).not.toContain('Gateway');
  });

  test('uses only public smthrs entry points for durable controls', () => {
    const source = createSmithersControlScript();
    expect(source).toContain("from 'smthrs'");
    expect(source).toContain("from 'smthrs/openSmithersStore'");
    expect(source).not.toContain('@smthrs/engine');
    expect(source).not.toContain('@smithers-orchestrator');
    expect(source).not.toContain('Gateway');
  });

  test('declares smthrs, not @smthrs/engine, as the owned runtime dependency', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.smthrs).toBe('0.33.0');
    expect(manifest.dependencies?.['@smthrs/engine']).toBeUndefined();
    expect(manifest.devDependencies?.['@smthrs/engine']).toBeUndefined();
  });
});
