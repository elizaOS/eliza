import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWallet, listWallets, loadWalletKeypair, signWalletMessage } from './wallet.js';

let tmpDir: string;
const originalWalletDir = process.env.CLAWD_WALLET_DIR;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'clawd-wallet-test-'));
  process.env.CLAWD_WALLET_DIR = tmpDir;
});

afterEach(() => {
  if (originalWalletDir === undefined) delete process.env.CLAWD_WALLET_DIR;
  else process.env.CLAWD_WALLET_DIR = originalWalletDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('wallet', () => {
  test('createWallet generates a valid base58 Solana public key', () => {
    const record = createWallet('test-wallet');

    assert.equal(record.name, 'test-wallet');
    assert.match(record.publicKey, /^[1-9A-HJ-NP-Za-km-z]+$/, 'public key must be valid base58');
    // Solana pubkeys are 32 bytes; base58-encoded that's typically 32-44 chars.
    assert.ok(record.publicKey.length >= 32 && record.publicKey.length <= 44);
  });

  test('createWallet refuses to overwrite an existing wallet', () => {
    createWallet('dup');
    assert.throws(() => createWallet('dup'), /already exists/i);
  });

  test('createWallet strips path separators so traversal names cannot escape the wallet dir', () => {
    // '/' and '\' are stripped by the sanitizer; literal dots are preserved
    // (so the on-disk filename may still contain "..", e.g. "..-..-etc-passwd.json"),
    // but with no separator surviving, join() can never resolve outside tmpDir.
    const record = createWallet('../../etc/passwd');
    assert.ok(record.path.startsWith(`${tmpDir}/`), 'resolved path must stay inside the wallet dir');
    assert.equal(record.path.includes('/', tmpDir.length + 1), false, 'sanitized filename must contain no path separator');
    assert.ok(record.path.endsWith('.json'));
  });

  test('listWallets returns an empty array when no wallets exist', () => {
    assert.deepEqual(listWallets(), []);
  });

  test('listWallets round-trips the same public key createWallet returned', () => {
    const created = createWallet('roundtrip');
    const listed = listWallets();

    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'roundtrip');
    assert.equal(listed[0].publicKey, created.publicKey);
  });

  test('two generated wallets have different keys (no accidental determinism)', () => {
    const a = createWallet('a');
    const b = createWallet('b');
    assert.notEqual(a.publicKey, b.publicKey);
  });

  test('multiple wallets all round-trip correctly through listWallets', () => {
    const names = ['alpha', 'beta', 'gamma'];
    const created = names.map((n) => createWallet(n));
    const listed = listWallets().sort((a, b) => a.name.localeCompare(b.name));

    assert.equal(listed.length, 3);
    for (let i = 0; i < names.length; i++) {
      const match = created.find((c) => c.name === listed[i].name);
      assert.ok(match, `expected a created wallet named ${listed[i].name}`);
      assert.equal(listed[i].publicKey, match?.publicKey);
    }
  });

  test('loadWalletKeypair returns the stored secret without changing the public key', () => {
    const created = createWallet('signer');
    const loaded = loadWalletKeypair('signer');

    assert.equal(loaded.publicKey, created.publicKey);
    assert.equal(loaded.secretKey.length, 64);
  });

  test('signWalletMessage signs an Imperial connect message as base58', () => {
    const created = createWallet('imperial');
    const message = `imperial:mobile-connect:${created.publicKey}:nonce-1`;
    const signed = signWalletMessage('imperial', message);

    assert.equal(signed.wallet, created.publicKey);
    assert.equal(signed.message, message);
    assert.match(signed.signature, /^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});
