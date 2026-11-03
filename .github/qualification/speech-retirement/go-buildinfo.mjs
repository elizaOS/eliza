/** Bounded metadata parser for the reviewed Linux x64 Go inline build-info format. */
import { createHash } from 'node:crypto';

export function readGoBuildInfo(bytes) {
  const fail = message => { throw new Error('Unsupported native build info: ' + message); };
  if (bytes.length < 64 || bytes.length > 67108864 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) fail('ELF identity');
  const number = value => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('offset precision');
    return Number(value);
  };
  const slice = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) fail('file bounds');
    return bytes.subarray(offset, offset + length);
  };
  const table = number(bytes.readBigUInt64LE(40));
  const stride = bytes.readUInt16LE(58), count = bytes.readUInt16LE(60), namesIndex = bytes.readUInt16LE(62);
  if (stride !== 64 || count < 1 || count > 4096 || namesIndex >= count) fail('section table');
  slice(table, stride * count);
  const header = index => slice(table + stride * index, stride);
  const data = section => slice(number(section.readBigUInt64LE(24)), number(section.readBigUInt64LE(32)));
  const names = data(header(namesIndex));
  if (names.length > 65536) fail('section-name table cap');
  const matches = [];
  for (let i = 0; i < count; i++) {
    const section = header(i), start = section.readUInt32LE(0);
    if (start >= names.length) fail('section name offset');
    const end = names.indexOf(0, start);
    if (end < 0 || end - start > 128) fail('section name');
    if (names.subarray(start, end).toString('ascii') === '.go.buildinfo') matches.push(data(section));
  }
  if (matches.length !== 1 || matches[0].length < 32 || matches[0].length > 65536) fail('single bounded Go section');
  const info = matches[0];
  if (!info.subarray(0, 14).equals(Buffer.from('\xff Go buildinf:', 'latin1')) || info[14] !== 8 || info[15] !== 2) fail('inline little-endian header');
  let cursor = 32;
  const boundedBytes = maximum => {
    let length = 0, scale = 1, terminated = false;
    for (let i = 0; i < 8; i++) {
      if (cursor >= info.length) fail('varint boundary');
      const byte = info[cursor++];
      length += (byte & 127) * scale;
      if (!Number.isSafeInteger(length)) fail('varint precision');
      if (!(byte & 128)) { terminated = true; break; }
      scale *= 128;
    }
    if (!terminated || length > maximum || cursor + length > info.length) fail('string bounds');
    const result = info.subarray(cursor, cursor + length);
    cursor += length;
    return result;
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const version = decoder.decode(boundedBytes(128)), moduleFramed = boundedBytes(32768);
  // Go's own reader removes 16-byte module-info sentinels with this newline check.
  if (moduleFramed.length < 33 || moduleFramed[moduleFramed.length - 17] !== 10) fail('module-info framing');
  const moduleText = decoder.decode(moduleFramed.subarray(16, -16));
  const settings = {}, paths = [];
  for (const line of moduleText.split('\n')) {
    if (line.startsWith('path\t')) paths.push(line.slice(5));
    if (line.startsWith('build\t')) {
      const value = line.slice(6), equal = value.indexOf('=');
      if (equal < 1) fail('build setting');
      const key = value.slice(0, equal);
      if (Object.hasOwn(settings, key)) fail('duplicate build setting');
      settings[key] = value.slice(equal + 1);
    }
  }
  if (!/^go1\.(26|27)\.\d+$/.test(version) || paths.length !== 1 || paths[0] !== 'github.com/microsoft/typescript-go/cmd/tsgo' || settings['-compiler'] !== 'gc' || settings.GOOS !== 'linux' || settings.GOARCH !== 'amd64') fail('reviewed standard runtime/compiler platform');
  if (settings.CGO_ENABLED !== undefined && !['0', '1'].includes(settings.CGO_ENABLED)) fail('cgo metadata');
  if (settings['vcs.revision'] !== undefined && !/^[a-f0-9]{40}$/.test(settings['vcs.revision'])) fail('revision metadata');
  return { version, path: paths[0], compiler: settings['-compiler'], GOOS: settings.GOOS,
    GOARCH: settings.GOARCH, CGO_ENABLED: settings.CGO_ENABLED ?? null,
    vcsRevision: settings['vcs.revision'] ?? null,
    moduleInfoSHA256: createHash('sha256').update(moduleText).digest('hex'),
    format: 'ELF64-LE .go.buildinfo inline', memoryControl: 'GOMEMLIMIT_SUPPORTED_SOFT_TARGET',
    support: 'Official Go1.26/1.27 runtime sources; no runtime execution by this parser' };
}
