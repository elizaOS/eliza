import { describe, it, expect } from 'bun:test';
import {
  fromHex,
  toHex,
  fromString,
  toString,
  fromBytes,
  alloc,
  concat,
  slice,
  equals,
  isBuffer,
  byteLength,
  randomBytes,
} from '../buffer';

describe('buffer utils', () => {
  it('converts hex <-> buffer', () => {
    const hex = 'deadbeef01ff';
    const buf = fromHex(hex);
    expect(byteLength(buf)).toBe(6);
    expect(toHex(buf)).toBe(hex);
  });

  it('converts string utf8 <-> buffer', () => {
    const str = 'Hello, 世界';
    const buf = fromString(str, 'utf8');
    const out = toString(buf, 'utf8');
    expect(out).toBe(str);
  });

  it('converts string base64 <-> buffer', () => {
    const str = 'hello-base64';
    const b64 = 'aGVsbG8tYmFzZTY0';
    const bufFromB64 = fromString(b64, 'base64');
    expect(toString(bufFromB64, 'utf8')).toBe(str);

    const bufFromStr = fromString(str, 'utf8');
    expect(toString(bufFromStr, 'base64')).toBe(b64);
  });

  it('creates from bytes and allocates', () => {
    const bytes = [1, 2, 3, 4];
    const buf = fromBytes(bytes);
    expect(byteLength(buf)).toBe(4);
    expect(toHex(buf)).toBe('01020304');

    const zero = alloc(3);
    expect(byteLength(zero)).toBe(3);
    // All zeros
    expect(toHex(zero)).toBe('000000');
  });

  it('concatenates and slices buffers', () => {
    const a = fromHex('aa');
    const b = fromHex('bbcc');
    const c = concat([a, b]);
    expect(toHex(c)).toBe('aabbcc');

    const s = slice(c, 1, 3);
    expect(toHex(s)).toBe('bbcc');
  });

  it('checks equality and buffer detection', () => {
    const a = fromHex('0a0b0c');
    const b = fromHex('0a0b0c');
    const c = fromHex('0a0b0d');
    expect(equals(a, b)).toBe(true);
    expect(equals(a, c)).toBe(false);

    expect(isBuffer(a)).toBe(true);
    expect(isBuffer(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(isBuffer({})).toBe(false);
  });

  it('generates random bytes with correct length', () => {
    const r = randomBytes(16);
    expect(byteLength(r)).toBe(16);
  });
});
