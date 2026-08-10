/**
 * Tests the workflow package's deterministic test-file discovery with a real
 * temporary directory tree; child-process behavior is exercised by the full
 * package command rather than mocked here.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discoverWorkflowTestFiles,
  parseWorkflowTestArgs,
} from '../../scripts/run-isolated-tests.mjs';

describe('workflow isolated test runner', () => {
  it('discovers only test/spec modules in deterministic order', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'workflow-test-runner-'));
    try {
      const nested = path.join(root, 'nested');
      mkdirSync(nested);
      writeFileSync(path.join(root, 'z.test.ts'), '');
      writeFileSync(path.join(root, 'a.spec.mjs'), '');
      writeFileSync(path.join(root, 'fixture.ts'), '');
      writeFileSync(path.join(nested, 'b.test.tsx'), '');

      const relativeRoot = path.relative(path.resolve(import.meta.dir, '../..'), root);
      expect(discoverWorkflowTestFiles(root)).toEqual([
        path.join(relativeRoot, 'a.spec.mjs'),
        path.join(relativeRoot, 'nested', 'b.test.tsx'),
        path.join(relativeRoot, 'z.test.ts'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a complete JUnit reporter pair', () => {
    expect(parseWorkflowTestArgs([])).toEqual({ reporterOutfile: undefined });
    expect(
      parseWorkflowTestArgs(['--reporter=junit', '--reporter-outfile=/tmp/workflow.xml'])
    ).toEqual({ reporterOutfile: '/tmp/workflow.xml' });
    expect(() => parseWorkflowTestArgs(['--reporter=junit'])).toThrow('requires both');
    expect(() => parseWorkflowTestArgs(['--unknown'])).toThrow('unknown argument');
  });
});
