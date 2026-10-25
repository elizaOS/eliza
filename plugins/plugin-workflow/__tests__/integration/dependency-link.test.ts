import { expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkflowDependencyLink } from '../../src/services/workflow-dependency-link';

test('dependency links recover after artifact update without deleting state or foreign files', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-links-')));
  try {
    const old = join(root, 'old');
    const current = join(root, 'current');
    mkdirSync(old);
    mkdirSync(current);
    writeFileSync(join(old, 'identity'), 'old');
    writeFileSync(join(current, 'identity'), 'new');
    const link = join(root, 'state/node_modules/smthrs');
    ensureWorkflowDependencyLink(old, link);
    expect(readFileSync(join(link, 'identity'), 'utf8')).toBe('old');
    ensureWorkflowDependencyLink(current, link);
    expect(readFileSync(join(link, 'identity'), 'utf8')).toBe('new');
    expect(readFileSync(join(old, 'identity'), 'utf8')).toBe('old');
    const inode = lstatSync(link).ino;
    ensureWorkflowDependencyLink(current, link);
    expect(lstatSync(link).ino).toBe(inode);
    rmSync(link);
    symlinkSync(join(root, 'removed-artifact'), link);
    ensureWorkflowDependencyLink(current, link);
    expect(readlinkSync(link)).toBe(current);
    rmSync(link);
    writeFileSync(link, 'foreign');
    expect(() => ensureWorkflowDependencyLink(current, link)).toThrow('not a symbolic link');
    expect(readFileSync(link, 'utf8')).toBe('foreign');
    rmSync(link);
    mkdirSync(link);
    writeFileSync(join(link, 'keep'), 'state');
    expect(() => ensureWorkflowDependencyLink(current, link)).toThrow('not a symbolic link');
    expect(readFileSync(join(link, 'keep'), 'utf8')).toBe('state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
