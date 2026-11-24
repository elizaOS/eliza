// spec/core/settingsKeys.md, "Story: Keep persisted settings decryptable under the selected key"; spec/core/protocols.md, "Story: Share canonical values across hosts and plugins"
const utf8Encoder = new TextEncoder();

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? utf8Encoder.encode(input) : input;
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function sha1Bytes(input: string | Uint8Array): Uint8Array {
  const data = toBytes(input);
  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const data = toBytes(input);
  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

export function sha256HexSync(input: string | Uint8Array): string {
  return bytesToHex(sha256Bytes(input));
}

const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) INV_SBOX[SBOX[i]] = i;

const RCON = new Uint8Array([0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40]);

function xtime(value: number): number {
  return ((value << 1) ^ ((value & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
}

function gfMul(a: number, b: number): number {
  let result = 0;
  let left = a;
  let right = b;
  for (let i = 0; i < 8; i += 1) {
    if ((right & 1) !== 0) result ^= left;
    left = xtime(left);
    right >>>= 1;
  }
  return result;
}

function expandAes256Key(key: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error("AES-256 requires a 32-byte key");
  }
  const roundKeys = new Uint8Array(240);
  roundKeys.set(key);
  let bytesGenerated = 32;
  let rconIndex = 1;
  const temp = new Uint8Array(4);
  while (bytesGenerated < 240) {
    for (let i = 0; i < 4; i += 1) temp[i] = roundKeys[bytesGenerated - 4 + i];
    if (bytesGenerated % 32 === 0) {
      const t = temp[0];
      temp[0] = SBOX[temp[1]] ^ RCON[rconIndex];
      temp[1] = SBOX[temp[2]];
      temp[2] = SBOX[temp[3]];
      temp[3] = SBOX[t];
      rconIndex += 1;
    } else if (bytesGenerated % 32 === 16) {
      temp[0] = SBOX[temp[0]];
      temp[1] = SBOX[temp[1]];
      temp[2] = SBOX[temp[2]];
      temp[3] = SBOX[temp[3]];
    }
    for (let i = 0; i < 4; i += 1) {
      roundKeys[bytesGenerated] = roundKeys[bytesGenerated - 32] ^ temp[i];
      bytesGenerated += 1;
    }
  }
  return roundKeys;
}

function addRoundKey(state: Uint8Array, roundKeys: Uint8Array, round: number): void {
  const offset = round * 16;
  for (let i = 0; i < 16; i += 1) state[i] ^= roundKeys[offset + i];
}

function aes256EncryptBlock(roundKeys: Uint8Array, input: Uint8Array, output: Uint8Array): void {
  const s = new Uint8Array(16);
  s.set(input.subarray(0, 16));
  addRoundKey(s, roundKeys, 0);
  for (let round = 1; round <= 14; round += 1) {
    for (let i = 0; i < 16; i += 1) s[i] = SBOX[s[i]];
    const t1 = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t1;
    const t2 = s[2]; s[2] = s[10]; s[10] = t2;
    const t6 = s[6]; s[6] = s[14]; s[14] = t6;
    const t3 = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t3;
    if (round < 14) {
      for (let col = 0; col < 16; col += 4) {
        const a0 = s[col];
        const a1 = s[col + 1];
        const a2 = s[col + 2];
        const a3 = s[col + 3];
        const xor = a0 ^ a1 ^ a2 ^ a3;
        s[col] = a0 ^ xor ^ xtime(a0 ^ a1);
        s[col + 1] = a1 ^ xor ^ xtime(a1 ^ a2);
        s[col + 2] = a2 ^ xor ^ xtime(a2 ^ a3);
        s[col + 3] = a3 ^ xor ^ xtime(a3 ^ a0);
      }
    }
    addRoundKey(s, roundKeys, round);
  }
  output.set(s);
}

function aes256DecryptBlock(roundKeys: Uint8Array, input: Uint8Array, output: Uint8Array): void {
  const s = new Uint8Array(16);
  s.set(input.subarray(0, 16));
  addRoundKey(s, roundKeys, 14);
  for (let round = 13; round >= 0; round -= 1) {
    const t1 = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t1;
    const t2 = s[2]; s[2] = s[10]; s[10] = t2;
    const t6 = s[6]; s[6] = s[14]; s[14] = t6;
    const t3 = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t3;
    for (let i = 0; i < 16; i += 1) s[i] = INV_SBOX[s[i]];
    addRoundKey(s, roundKeys, round);
    if (round > 0) {
      for (let col = 0; col < 16; col += 4) {
        const a0 = s[col];
        const a1 = s[col + 1];
        const a2 = s[col + 2];
        const a3 = s[col + 3];
        s[col] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
        s[col + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
        s[col + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
        s[col + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
      }
    }
  }
  output.set(s);
}

function ghashMul(x: Uint8Array, h: Uint8Array): void {
  const z = new Uint8Array(16);
  const v = new Uint8Array(h);
  for (let byte = 0; byte < 16; byte += 1) {
    const b = x[byte];
    for (let bit = 7; bit >= 0; bit -= 1) {
      if (((b >>> bit) & 1) !== 0) {
        for (let i = 0; i < 16; i += 1) z[i] ^= v[i];
      }
      const lsb = v[15] & 1;
      for (let i = 15; i > 0; i -= 1) {
        v[i] = ((v[i] >>> 1) | ((v[i - 1] & 1) << 7)) & 0xff;
      }
      v[0] = (v[0] >>> 1) ^ (lsb !== 0 ? 0xe1 : 0);
    }
  }
  x.set(z);
}

function ghashUpdate(state: Uint8Array, h: Uint8Array, data: Uint8Array): void {
  const block = new Uint8Array(16);
  for (let offset = 0; offset < data.length; offset += 16) {
    block.fill(0);
    const slice = data.subarray(offset, Math.min(offset + 16, data.length));
    block.set(slice);
    for (let i = 0; i < 16; i += 1) state[i] ^= block[i];
    ghashMul(state, h);
  }
}

function incrementCounter(counter: Uint8Array): void {
  for (let i = 15; i >= 12; i -= 1) {
    counter[i] = (counter[i] + 1) & 0xff;
    if (counter[i] !== 0) break;
  }
}

function gcmInitialCounter(h: Uint8Array, iv: Uint8Array): Uint8Array {
  if (iv.length === 12) {
    const j0 = new Uint8Array(16);
    j0.set(iv, 0);
    j0[15] = 1;
    return j0;
  }
  const j0 = new Uint8Array(16);
  ghashUpdate(j0, h, iv);
  const lengths = new Uint8Array(16);
  const view = new DataView(lengths.buffer);
  const ivBits = iv.length * 8;
  view.setUint32(8, Math.floor(ivBits / 0x100000000), false);
  view.setUint32(12, ivBits >>> 0, false);
  for (let i = 0; i < 16; i += 1) j0[i] ^= lengths[i];
  ghashMul(j0, h);
  return j0;
}

function gcmTag(roundKeys: Uint8Array, h: Uint8Array, j0: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const s = new Uint8Array(16);
  if (aad.length > 0) ghashUpdate(s, h, aad);
  if (ciphertext.length > 0) ghashUpdate(s, h, ciphertext);
  const lengths = new Uint8Array(16);
  const view = new DataView(lengths.buffer);
  const aadBits = aad.length * 8;
  const ctBits = ciphertext.length * 8;
  view.setUint32(0, Math.floor(aadBits / 0x100000000), false);
  view.setUint32(4, aadBits >>> 0, false);
  view.setUint32(8, Math.floor(ctBits / 0x100000000), false);
  view.setUint32(12, ctBits >>> 0, false);
  for (let i = 0; i < 16; i += 1) s[i] ^= lengths[i];
  ghashMul(s, h);
  const mask = new Uint8Array(16);
  aes256EncryptBlock(roundKeys, j0, mask);
  for (let i = 0; i < 16; i += 1) s[i] ^= mask[i];
  return s;
}

function gcmCrypt(roundKeys: Uint8Array, j0: Uint8Array, input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length);
  const counter = new Uint8Array(j0);
  const keystream = new Uint8Array(16);
  for (let offset = 0; offset < input.length; offset += 16) {
    incrementCounter(counter);
    aes256EncryptBlock(roundKeys, counter, keystream);
    const len = Math.min(16, input.length - offset);
    for (let i = 0; i < len; i += 1) {
      output[offset + i] = input[offset + i] ^ keystream[i];
    }
  }
  return output;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function encryptAes256GcmSync(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const roundKeys = expandAes256Key(key);
  const h = new Uint8Array(16);
  aes256EncryptBlock(roundKeys, new Uint8Array(16), h);
  const j0 = gcmInitialCounter(h, iv);
  const ciphertext = gcmCrypt(roundKeys, j0, plaintext);
  const tag = gcmTag(roundKeys, h, j0, aad ?? new Uint8Array(0), ciphertext);
  return { ciphertext, tag };
}

export function decryptAes256GcmSync(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (tag.length !== 16) {
    throw new Error("Unsupported state or unable to authenticate data");
  }
  const roundKeys = expandAes256Key(key);
  const h = new Uint8Array(16);
  aes256EncryptBlock(roundKeys, new Uint8Array(16), h);
  const j0 = gcmInitialCounter(h, iv);
  const expectedTag = gcmTag(roundKeys, h, j0, aad ?? new Uint8Array(0), ciphertext);
  if (!constantTimeEqual(expectedTag, tag)) {
    throw new Error("Unsupported state or unable to authenticate data");
  }
  return gcmCrypt(roundKeys, j0, ciphertext);
}

export function decryptAes256CbcSync(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (iv.length !== 16) {
    throw new Error("AES-256-CBC requires a 16-byte IV");
  }
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error("Invalid AES-256-CBC ciphertext length");
  }
  const roundKeys = expandAes256Key(key);
  const plain = new Uint8Array(ciphertext.length);
  const prev = new Uint8Array(iv);
  const blockOut = new Uint8Array(16);
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    const blockIn = ciphertext.subarray(offset, offset + 16);
    aes256DecryptBlock(roundKeys, blockIn, blockOut);
    for (let i = 0; i < 16; i += 1) {
      plain[offset + i] = blockOut[i] ^ prev[i];
    }
    prev.set(blockIn);
  }
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 16) {
    throw new Error("bad decrypt");
  }
  for (let i = plain.length - pad; i < plain.length; i += 1) {
    if (plain[i] !== pad) {
      throw new Error("bad decrypt");
    }
  }
  return plain.subarray(0, plain.length - pad);
}
