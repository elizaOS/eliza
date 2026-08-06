import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getInstalledSpinnerVerbs,
  installSpinnerPack,
  listSpinnerPacks,
  loadSpinnerPack,
  removeSpinnerPack,
} from './spinners.js';

function withTempSettings(fn: (settingsPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'clawd-spinners-test-'));
  try {
    fn(join(dir, 'settings.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

describe('spinner packs', () => {
  test('lists bundled packs and excludes metadata', () => {
    const packs = listSpinnerPacks();
    assert.ok(packs.length >= 40);
    assert.ok(packs.some((pack) => pack.name === 'developer'));
    assert.equal(packs.some((pack) => pack.name === 'metadata'), false);
  });

  test('loads and validates a spinner pack', () => {
    const pack = loadSpinnerPack('developer');
    assert.equal(pack.name, 'developer');
    assert.equal(pack.spinnerVerbs.mode, 'replace');
    assert.ok(pack.spinnerVerbs.verbs.includes('Rewriting in Rust'));
  });

  test('installs a pack by replacing only spinnerVerbs', () => withTempSettings((settingsPath) => {
    writeFileSync(settingsPath, JSON.stringify({ keep: { nested: true }, spinnerVerbs: { verbs: ['old'] } }));

    const result = installSpinnerPack('developer', { settingsPath });
    const settings = readSettings(settingsPath);

    assert.equal(result.packName, 'developer');
    assert.equal(result.verbCount, 35);
    assert.deepEqual(settings.keep, { nested: true });
    assert.deepEqual(settings.spinnerVerbs, {
      mode: 'replace',
      verbs: loadSpinnerPack('developer').spinnerVerbs.verbs,
    });
  }));

  test('removes spinnerVerbs without deleting unrelated settings', () => withTempSettings((settingsPath) => {
    writeFileSync(settingsPath, JSON.stringify({ keep: 'value', spinnerVerbs: { mode: 'replace', verbs: ['old'] } }));

    const result = removeSpinnerPack({ settingsPath });
    const settings = readSettings(settingsPath);

    assert.equal(result.removed, true);
    assert.deepEqual(settings, { keep: 'value' });
  }));

  test('reports installed spinner verbs when present', () => withTempSettings((settingsPath) => {
    installSpinnerPack('vibecoder', { settingsPath });
    const installed = getInstalledSpinnerVerbs({ settingsPath });

    assert.equal(installed.settingsPath, settingsPath);
    assert.equal(installed.spinnerVerbs?.verbs[0], 'Vibing with the codebase');
  }));
});
