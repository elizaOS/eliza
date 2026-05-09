type NodeCallback = (error: Error | null, result?: unknown) => void;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function unavailable(name: string): never {
  throw new Error(`${name} is not available in this browser example.`);
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  return encoder.encode(String(value ?? ""));
}

function hashBytes(value: unknown, length = 32): Uint8Array {
  const input = toBytes(value);
  let hash = 2166136261;
  for (const byte of input) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }

  const out = new Uint8Array(length);
  for (let i = 0; i < out.length; i += 1) {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    out[i] = hash & 0xff;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class BrowserHash {
  readonly #chunks: Uint8Array[] = [];

  update(data: unknown): this {
    this.#chunks.push(toBytes(data));
    return this;
  }

  digest(encoding: "hex" | "base64" | "buffer" = "hex"): string | Uint8Array {
    const totalLength = this.#chunks.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }

    const digest = hashBytes(data, 32);
    if (encoding === "base64") return toBase64(digest);
    if (encoding === "buffer") return digest;
    return toHex(digest);
  }
}

type BrowserBuffer = Uint8Array & {
  toString: (encoding?: "hex" | "base64" | "utf8" | "utf-8") => string;
};

function makeBuffer(bytes: Uint8Array): BrowserBuffer {
  const buffer = new Uint8Array(bytes) as BrowserBuffer;
  buffer.toString = (
    encoding: "hex" | "base64" | "utf8" | "utf-8" = "utf-8",
  ): string => {
    if (encoding === "hex") return toHex(buffer);
    if (encoding === "base64") return toBase64(buffer);
    return decoder.decode(buffer);
  };
  return buffer;
}

export const Buffer = {
  from(value: unknown, _encoding?: string): BrowserBuffer {
    return makeBuffer(toBytes(value));
  },
  alloc(size: number, fill = 0): BrowserBuffer {
    return makeBuffer(new Uint8Array(size).fill(fill));
  },
  isBuffer(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array;
  },
  byteLength(value: unknown): number {
    return toBytes(value).byteLength;
  },
  concat(chunks: Uint8Array[], totalLength?: number): BrowserBuffer {
    const length =
      totalLength ?? chunks.reduce((total, chunk) => total + chunk.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return makeBuffer(out);
  },
};

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto?.getRandomValues(bytes);
  return bytes;
}

export function randomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? toHex(randomBytes(16));
}

export function createHash(_algorithm: string): BrowserHash {
  return new BrowserHash();
}

export function createHmac(_algorithm: string, key: unknown): BrowserHash {
  return new BrowserHash().update(key);
}

export function pbkdf2Sync(
  password: unknown,
  salt: unknown,
  iterations: number,
  keylen: number,
  digest: string,
): Uint8Array {
  return hashBytes(
    `${String(password)}:${String(salt)}:${iterations}:${digest}`,
    keylen,
  );
}

export function scryptSync(
  password: unknown,
  salt: unknown,
  keylen: number,
): Uint8Array {
  return hashBytes(`${String(password)}:${String(salt)}`, keylen);
}

export function createCipheriv(): never {
  return unavailable("crypto.createCipheriv");
}

export function createDecipheriv(): never {
  return unavailable("crypto.createDecipheriv");
}

export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto?.subtle;

export function join(...paths: string[]): string {
  return normalize(paths.filter(Boolean).join("/"));
}

export function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || (absolute ? "/" : ".");
}

export function resolve(...paths: string[]): string {
  const lastAbsolute = [...paths]
    .reverse()
    .find((path) => path.startsWith("/"));
  return normalize(lastAbsolute ?? `/${paths.join("/")}`);
}

export function dirname(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

export function basename(path: string, ext = ""): string {
  let base = normalize(path).split("/").pop() ?? "";
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}

export function extname(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index) : "";
}

export function parse(path: string): {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
} {
  const base = basename(path);
  const ext = extname(base);
  return {
    root: path.startsWith("/") ? "/" : "",
    dir: dirname(path),
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

export function format(pathObject: {
  dir?: string;
  root?: string;
  base?: string;
  name?: string;
  ext?: string;
}): string {
  const base =
    pathObject.base ?? `${pathObject.name ?? ""}${pathObject.ext ?? ""}`;
  return join(pathObject.dir ?? pathObject.root ?? "", base);
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

export function relative(_from: string, to: string): string {
  return normalize(to).replace(/^\//, "");
}

export const sep = "/";
export const delimiter = ":";

export function fileURLToPath(url: string | URL): string {
  const value = typeof url === "string" ? new URL(url) : url;
  return decodeURIComponent(value.pathname);
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${path.startsWith("/") ? "" : "/"}${path}`);
}

const emptyStats = {
  isDirectory: () => false,
  isFile: () => false,
  isSymbolicLink: () => false,
  size: 0,
  mtimeMs: 0,
};

export function existsSync(): boolean {
  return false;
}

export function mkdirSync(): void {}
export function readdirSync(): string[] {
  return [];
}
export function readFileSync(): string {
  return "";
}
export function writeFileSync(): void {}
export function statSync(): typeof emptyStats {
  return emptyStats;
}

export async function access(): Promise<void> {
  return unavailable("fs.promises.access");
}
export async function mkdir(): Promise<void> {}
export async function readFile(): Promise<never> {
  return unavailable("fs.promises.readFile");
}
export async function writeFile(): Promise<never> {
  return unavailable("fs.promises.writeFile");
}
export async function rename(): Promise<never> {
  return unavailable("fs.promises.rename");
}
export async function rm(): Promise<void> {}
export async function unlink(): Promise<void> {}
export async function readdir(): Promise<string[]> {
  return [];
}
export async function stat(): Promise<typeof emptyStats> {
  return emptyStats;
}

export const promises = {
  access,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  unlink,
  readdir,
  stat,
};

export function ensureDirSync(): void {}
export async function ensureDir(): Promise<void> {}
export const mkdirp = ensureDir;
export const mkdirpSync = ensureDirSync;
export const pathExists = async (): Promise<boolean> => false;
export const pathExistsSync = existsSync;
export const readJson = readFile;
export const writeJson = writeFile;
export const remove = rm;
export const removeSync = (): void => {};
export const copy = async (): Promise<void> => {};
export const copySync = (): void => {};
export const move = rename;
export const moveSync = (): void => {};

export function createReadStream(): never {
  return unavailable("fs.createReadStream");
}

export function createWriteStream(): never {
  return unavailable("fs.createWriteStream");
}

export class Readable {
  static from<T>(iterable: Iterable<T> | AsyncIterable<T>): typeof iterable {
    return iterable;
  }
}
export class Writable {}
export class PassThrough {}
export class Stream {}

export function homedir(): string {
  return "/";
}
export function tmpdir(): string {
  return "/tmp";
}
export function platform(): string {
  return "browser";
}
export function cpus(): never[] {
  return [];
}

export class EventEmitter {
  on(): this {
    return this;
  }

  once(): this {
    return this;
  }

  off(): this {
    return this;
  }

  removeListener(): this {
    return this;
  }

  emit(): boolean {
    return false;
  }
}

export function ok(
  value: unknown,
  message = "Assertion failed",
): asserts value {
  if (!value) throw new Error(message);
}

export function fail(message = "Assertion failed"): never {
  throw new Error(message);
}

export function strictEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) fail("Expected values to be strictly equal");
}

export function deepStrictEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("Expected values to be deeply equal");
  }
}

export const strict = {
  deepStrictEqual,
  equal: strictEqual,
  fail,
  ok,
  strictEqual,
};

const childProcessHandle = {
  kill: () => undefined,
  on: () => childProcessHandle,
};

export function exec(
  _command: string,
  callback?: NodeCallback,
): typeof childProcessHandle {
  callback?.(new Error("child_process.exec is not available in browsers"));
  return childProcessHandle;
}

export function execFile(
  _file: string,
  _args?: string[] | NodeCallback,
  callback?: NodeCallback,
): typeof childProcessHandle {
  const cb = typeof _args === "function" ? _args : callback;
  cb?.(new Error("child_process.execFile is not available in browsers"));
  return childProcessHandle;
}

export async function lookup(): Promise<never> {
  return unavailable("dns.lookup");
}

export function request(): never {
  return unavailable("http.request");
}

export function connect(): never {
  return unavailable("net.connect");
}

export const createConnection = connect;

export function gzipSync(value: unknown): Uint8Array {
  return toBytes(value);
}

export const gunzipSync = gzipSync;
export const deflateSync = gzipSync;
export const inflateSync = gzipSync;

export class AsyncLocalStorage<T> {
  #store?: T;

  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    this.#store = store;
    return callback(...args);
  }

  getStore(): T | undefined {
    return this.#store;
  }
}

export function createHook(): { enable: () => void; disable: () => void } {
  return {
    enable: () => undefined,
    disable: () => undefined,
  };
}

export function runInNewContext(): never {
  return unavailable("vm.runInNewContext");
}

export function promisify<Args extends unknown[], Result>(
  fn: (...args: [...Args, NodeCallback]) => unknown,
): (...args: Args) => Promise<Result> {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (error, result) => {
        if (error) reject(error);
        else resolve(result as Result);
      });
    });
}

export function createRequire(): (specifier: string) => never {
  return (specifier: string) => unavailable(`require(${specifier})`);
}

export const F_OK = 0;
export const R_OK = 4;
export const W_OK = 2;
export const X_OK = 1;
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;

const nodeBuiltins = {
  AsyncLocalStorage,
  Buffer,
  EventEmitter,
  Readable,
  Writable,
  PassThrough,
  Stream,
  access,
  basename,
  copy,
  copySync,
  connect,
  cpus,
  createConnection,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHook,
  createHmac,
  createReadStream,
  createRequire,
  createWriteStream,
  deepStrictEqual,
  deflateSync,
  delimiter,
  dirname,
  ensureDir,
  ensureDirSync,
  exec,
  execFile,
  existsSync,
  extname,
  fail,
  fileURLToPath,
  format,
  gunzipSync,
  gzipSync,
  homedir,
  inflateSync,
  isAbsolute,
  join,
  lookup,
  mkdir,
  mkdirSync,
  mkdirp,
  mkdirpSync,
  move,
  moveSync,
  normalize,
  ok,
  parse,
  pathExists,
  pathExistsSync,
  pathToFileURL,
  pbkdf2Sync,
  platform,
  promises,
  promisify,
  randomBytes,
  randomUUID,
  readFile,
  readFileSync,
  readJson,
  readdir,
  readdirSync,
  relative,
  remove,
  removeSync,
  rename,
  request,
  resolve,
  rm,
  runInNewContext,
  scryptSync,
  sep,
  stat,
  statSync,
  strict,
  strictEqual,
  subtle,
  tmpdir,
  unlink,
  webcrypto,
  writeFile,
  writeFileSync,
  writeJson,
};

export default nodeBuiltins;
