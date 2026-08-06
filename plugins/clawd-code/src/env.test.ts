import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseEnvFile, parseGrokConfigToml, maskSecret, upsertEnvFile } from './env.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'clawd-env-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

describe('parseEnvFile', () => {
  test('returns {} for a missing file', () => {
    assert.deepEqual(parseEnvFile(join(tmpDir, 'nope.env')), {});
  });

  test('parses simple KEY=VALUE pairs', () => {
    const path = write('.env', 'FOO=bar\nBAZ=qux\n');
    assert.deepEqual(parseEnvFile(path), { FOO: 'bar', BAZ: 'qux' });
  });

  test('skips blank lines and comments', () => {
    const path = write('.env', '\n# a comment\nFOO=bar\n  # indented comment\n');
    assert.deepEqual(parseEnvFile(path), { FOO: 'bar' });
  });

  test('strips a leading "export " prefix', () => {
    const path = write('.env', 'export FOO=bar\n');
    assert.deepEqual(parseEnvFile(path), { FOO: 'bar' });
  });

  test('strips matching single or double quotes around values', () => {
    const path = write('.env', 'A="double"\nB=\'single\'\nC=unquoted\n');
    assert.deepEqual(parseEnvFile(path), { A: 'double', B: 'single', C: 'unquoted' });
  });

  test('handles "=" characters inside the value', () => {
    const path = write('.env', 'URL=https://example.com?a=1&b=2\n');
    assert.deepEqual(parseEnvFile(path), { URL: 'https://example.com?a=1&b=2' });
  });

  test('ignores lines with no "=" separator', () => {
    const path = write('.env', 'FOO=bar\nNOTANASSIGNMENT\n');
    assert.deepEqual(parseEnvFile(path), { FOO: 'bar' });
  });

  test('ignores entries with an empty key', () => {
    const path = write('.env', '=value\nFOO=bar\n');
    assert.deepEqual(parseEnvFile(path), { FOO: 'bar' });
  });
});

describe('parseGrokConfigToml', () => {
  test('returns empty defaults for a missing file', () => {
    assert.deepEqual(parseGrokConfigToml(join(tmpDir, 'nope.toml')), { flat: {}, modelAliases: {} });
  });

  test('reads [models] default into CLAWD_MODEL', () => {
    const path = write('config.toml', '[models]\ndefault = "grok-4.3"\n');
    const result = parseGrokConfigToml(path);
    assert.equal(result.flat.CLAWD_MODEL, 'grok-4.3');
    assert.equal(result.defaultModel, 'grok-4.3');
  });

  test('reads [model.<alias>] sections into modelAliases', () => {
    const path = write(
      'config.toml',
      [
        '[model.grok-fast]',
        'model = "grok-4.3-fast"',
        'base_url = "https://api.x.ai/v1"',
        'name = "Grok Fast"',
      ].join('\n'),
    );
    const result = parseGrokConfigToml(path);
    assert.deepEqual(result.modelAliases['grok-fast'], {
      model: 'grok-4.3-fast',
      baseUrl: 'https://api.x.ai/v1',
      name: 'Grok Fast',
    });
  });

  test('strips inline comments from unquoted values', () => {
    const path = write('config.toml', '[models]\ndefault = grok-4.3 # the good one\n');
    const result = parseGrokConfigToml(path);
    assert.equal(result.flat.CLAWD_MODEL, 'grok-4.3');
  });

  test('maps [ui] permission_mode and [session] auto_compact_threshold_percent', () => {
    const path = write(
      'config.toml',
      ['[ui]', 'permission_mode = "auto"', '[session]', 'auto_compact_threshold_percent = "80"'].join('\n'),
    );
    const result = parseGrokConfigToml(path);
    assert.equal(result.flat.CLAWD_PERMISSION_MODE, 'auto');
    assert.equal(result.flat.CLAWD_AUTO_COMPACT, '80');
  });

  test('maps [cli] auto_update=false to CLAWD_NO_AUTO_UPDATE=true', () => {
    const path = write('config.toml', '[cli]\nauto_update = "false"\n');
    const result = parseGrokConfigToml(path);
    assert.equal(result.flat.CLAWD_NO_AUTO_UPDATE, 'true');
  });
});

describe('upsertEnvFile', () => {
  test('updates existing keys and appends missing keys', () => {
    const path = write('.env', 'FOO=old\n# keep me\nexport BAR=old\n');

    upsertEnvFile(path, { FOO: 'new', BAR: 'newer', BAZ: 'added' });

    assert.deepEqual(parseEnvFile(path), { FOO: 'new', BAR: 'newer', BAZ: 'added' });
  });

  test('writes env files with 0600 permissions', () => {
    const path = join(tmpDir, '.env');

    upsertEnvFile(path, { FOO: 'bar' });

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe('maskSecret', () => {
  test('returns "(unset)" for undefined', () => {
    assert.equal(maskSecret(undefined), '(unset)');
  });

  test('shortens very short secrets to a prefix + ellipsis', () => {
    assert.equal(maskSecret('abc'), 'ab...');
  });

  test('masks long secrets to prefix...suffix, never the full value', () => {
    const secret = 'xai-1234567890abcdef';
    const masked = maskSecret(secret);
    assert.ok(masked.includes('...'));
    assert.ok(!masked.includes(secret));
    assert.equal(masked, 'xai-12...cdef');
  });
});
