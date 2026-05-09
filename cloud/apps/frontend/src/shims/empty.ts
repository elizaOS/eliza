// Empty stub for Node built-ins that legacy server-side modules import via
// the bundle graph. Any code that actually calls these functions in the
// browser will throw at runtime; the SPA never reaches those paths because
// the surrounding code is server-only and gated by checks like
// `typeof window === "undefined"`. Aliased in vite.config.ts.
//
// Each named export gets its OWN stub closure so the thrown error and the
// console warning name which export was called. The shared-Proxy approach
// previously used here meant every callsite produced an identical stack
// trace and we could not tell which built-in was hit.

type StubFn = (...args: unknown[]) => unknown;

const warned = new Set<string>();

function makeStub(name: string): StubFn {
  const warn = () => {
    if (typeof window !== "undefined" && !warned.has(name)) {
      warned.add(name);
      // Keep this as console.warn so it survives even if the surrounding
      // code swallows the throw with try/catch — the fingerprint of which
      // export was hit still reaches the console.
      console.warn(`[empty-shim] node-builtin stub '${name}' was called in the browser bundle`);
    }
  };
  // Real prototype object so `class X extends stub` works at module-init time.
  // JS engines read `Parent.prototype` and call `Object.create(Parent.prototype)`
  // when defining the subclass — if that returns undefined, you get
  // "Object prototype may only be an Object or null: undefined" before any
  // user code runs. We give every stub a real, plain object as its prototype
  // so the extends machinery succeeds. Construction still throws on `new`.
  const realProto: Record<PropertyKey, unknown> = Object.create(null) as Record<
    PropertyKey,
    unknown
  >;
  const fn: StubFn = () => {
    warn();
    throw new Error(
      `node-builtin stub '${name}' called in browser bundle — this code path is server-only`,
    );
  };
  // Override the function's own prototype to our plain object. This is what
  // `Reflect.get(target, "prototype")` will see when we forward in the Proxy.
  Object.defineProperty(fn, "prototype", {
    value: realProto,
    writable: true,
    enumerable: false,
    configurable: false,
  });
  return new Proxy(fn, {
    // Property access on the stub returns another named stub. This supports
    // consumers that do `import * as crypto from "crypto"` and then call
    // `crypto.someUnknownFn()` — the inner call still names the path.
    get(target, prop) {
      // Class-machinery + reflection properties must come from the real
      // function/prototype, not synthesized stubs. Returning undefined for
      // these breaks `class X extends stub` and `instanceof` checks at parse
      // time, before any try/catch can catch them.
      if (
        prop === "prototype" ||
        prop === "name" ||
        prop === "length" ||
        prop === "constructor" ||
        prop === Symbol.hasInstance ||
        prop === Symbol.toPrimitive ||
        prop === Symbol.toStringTag ||
        prop === "toString" ||
        prop === "valueOf" ||
        // Module-shape probes that should resolve to undefined, not a stub.
        // `__esModule` in particular: if a stub is treated as an ES module
        // namespace, returning a sub-stub here breaks default-import interop.
        prop === "__esModule" ||
        prop === Symbol.iterator ||
        prop === Symbol.asyncIterator ||
        prop === "then" // never look thenable
      ) {
        return Reflect.get(target, prop);
      }
      return makeStub(`${name}.${String(prop)}`);
    },
    apply(_t, _thisArg, _args) {
      warn();
      throw new Error(
        `node-builtin stub '${name}' called in browser bundle — this code path is server-only`,
      );
    },
    construct() {
      warn();
      throw new Error(`node-builtin stub '${name}' instantiated as constructor in browser bundle`);
    },
  }) as StubFn;
}

export class AsyncLocalStorage<T = unknown> {
  private store: T | undefined;

  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.store;
    this.store = store;
    try {
      return callback(...args);
    } finally {
      this.store = previous;
    }
  }

  getStore(): T | undefined {
    return this.store;
  }

  enterWith(store: T): void {
    this.store = store;
  }

  disable(): void {
    this.store = undefined;
  }
}

// Default export: a generic stub. Anything that does `import x from "fs"`
// and then `x.foo()` will hit `default.foo` and name the access path.
export default makeStub("default");

export const networkInterfaces = makeStub("networkInterfaces");
export const promises = makeStub("promises");
export const constants = makeStub("constants");
export const createServer = makeStub("createServer");
export const createConnection = makeStub("createConnection");
export const createCipheriv = makeStub("createCipheriv");
export const createDecipheriv = makeStub("createDecipheriv");
export const createHash = makeStub("createHash");
export const createHmac = makeStub("createHmac");
export const createSign = makeStub("createSign");
export const createVerify = makeStub("createVerify");
export const randomBytes = makeStub("randomBytes");
export const randomUUID = makeStub("randomUUID");
export const randomFillSync = makeStub("randomFillSync");
export const randomFill = makeStub("randomFill");
export const pbkdf2 = makeStub("pbkdf2");
export const pbkdf2Sync = makeStub("pbkdf2Sync");
export const scrypt = makeStub("scrypt");
export const scryptSync = makeStub("scryptSync");
export const timingSafeEqual = makeStub("timingSafeEqual");
export const subtle = makeStub("subtle");
export const webcrypto = makeStub("webcrypto");
export const readFile = makeStub("readFile");
export const readFileSync = makeStub("readFileSync");
export const writeFile = makeStub("writeFile");
export const writeFileSync = makeStub("writeFileSync");
export const existsSync = makeStub("existsSync");
export const statSync = makeStub("statSync");
export const readdirSync = makeStub("readdirSync");
export const join = makeStub("join");
export const resolve = makeStub("resolve");
export const dirname = makeStub("dirname");
export const basename = makeStub("basename");
export const extname = makeStub("extname");
export const sep = "/";
export const Readable = makeStub("Readable");
export const Writable = makeStub("Writable");
export const Transform = makeStub("Transform");
export const Duplex = makeStub("Duplex");
export const PassThrough = makeStub("PassThrough");
export const pipeline = makeStub("pipeline");
export const finished = makeStub("finished");
export const Buffer = makeStub("Buffer");
export const tmpdir = () => "/tmp";
export const homedir = () => "/";
export const platform = () => "browser";
export const arch = () => "x64";
export const cpus = () => [];
export const totalmem = () => 0;
export const freemem = () => 0;
export const hostname = () => "localhost";
export const release = () => "0";
export const type = () => "Browser";
export const userInfo = () => ({ username: "", uid: 0, gid: 0, shell: "", homedir: "/" });
export const get = makeStub("get");
export const request = makeStub("request");
export const Agent = makeStub("Agent");
export const STATUS_CODES = {};
export const METHODS = [];
export const execFile = makeStub("execFile");
export const exec = makeStub("exec");
export const spawn = makeStub("spawn");
export const spawnSync = makeStub("spawnSync");

// EventEmitter must be a real class (libraries do `extends EventEmitter`).
export class EventEmitter {
  private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(event: string, fn: (...args: unknown[]) => void) {
    (this._listeners[event] ||= []).push(fn);
    return this;
  }
  off(event: string, fn: (...args: unknown[]) => void) {
    this._listeners[event] = (this._listeners[event] || []).filter((f) => f !== fn);
    return this;
  }
  once(event: string, fn: (...args: unknown[]) => void) {
    const wrapper = (...args: unknown[]) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this._listeners[event] || []) fn(...args);
    return (this._listeners[event] || []).length > 0;
  }
  removeAllListeners(event?: string) {
    if (event) delete this._listeners[event];
    else this._listeners = {};
    return this;
  }
  addListener(event: string, fn: (...args: unknown[]) => void) {
    return this.on(event, fn);
  }
  removeListener(event: string, fn: (...args: unknown[]) => void) {
    return this.off(event, fn);
  }
  listeners(event: string) {
    return [...(this._listeners[event] || [])];
  }
  listenerCount(event: string) {
    return (this._listeners[event] || []).length;
  }
  setMaxListeners() {
    return this;
  }
  getMaxListeners() {
    return 10;
  }
  eventNames() {
    return Object.keys(this._listeners);
  }
}
export const captureRejectionSymbol = Symbol("captureRejection");
export const errorMonitor = Symbol("errorMonitor");
export const setMaxListeners = () => {};
export const getEventListeners = () => [];
export const once = () => Promise.resolve([]);
export const on_ = () => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
});
export const types = {};
export const inspect = (v: unknown) => String(v);
export const format = (v: unknown) => String(v);
export const promisify = (fn: unknown) => fn;
export const callbackify = (fn: unknown) => fn;
export const inherits = () => {};
export const isDeepStrictEqual = () => false;
export const TextDecoder = globalThis.TextDecoder;
export const TextEncoder = globalThis.TextEncoder;
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const fileURLToPath = (u: string | { href?: string }) =>
  typeof u === "string" ? u : (u.href ?? "");
export const pathToFileURL = (p: string) => new globalThis.URL(`file://${p}`);
export const channel = () => ({ publish: () => {}, subscribe: () => {}, unsubscribe: () => {} });
export const tracingChannel = channel;
export const lookup = makeStub("lookup");
export const resolve4 = makeStub("resolve4");
export const resolve6 = makeStub("resolve6");
export const isIP = makeStub("isIP");
export const Resolver = class {};
export const SocketAddress = class {};
export const Socket = makeStub("Socket");
export const Server = makeStub("Server");

// node:module — some dependencies import `createRequire`; real createRequire is
// meaningless in the browser; stub so the bundle resolves.
export const createRequire = (_url?: string | URL): ((id: string) => unknown) =>
  makeStub("createRequire.require");
export const builtinModules: string[] = [];
export const isBuiltin = () => false;
export const Module = class {};

// fs — optional names some server-oriented packages import for static analysis.
export const mkdir = makeStub("mkdir");
export const mkdirSync = makeStub("mkdirSync");
export const rmdir = makeStub("rmdir");
export const rmdirSync = makeStub("rmdirSync");
export const rm = makeStub("rm");
export const rmSync = makeStub("rmSync");
export const rename = makeStub("rename");
export const renameSync = makeStub("renameSync");
export const unlink = makeStub("unlink");
export const unlinkSync = makeStub("unlinkSync");
export const readdir = makeStub("readdir");
export const stat = makeStub("stat");
export const lstat = makeStub("lstat");
export const lstatSync = makeStub("lstatSync");
export const access = makeStub("access");
export const accessSync = makeStub("accessSync");
export const open = makeStub("open");
export const openSync = makeStub("openSync");
export const close = makeStub("close");
export const closeSync = makeStub("closeSync");
export const copyFile = makeStub("copyFile");
export const copyFileSync = makeStub("copyFileSync");
export const realpath = makeStub("realpath");
export const realpathSync = makeStub("realpathSync");
export const symlink = makeStub("symlink");
export const symlinkSync = makeStub("symlinkSync");
export const utimes = makeStub("utimes");
export const utimesSync = makeStub("utimesSync");
export const watch = makeStub("watch");
export const watchFile = makeStub("watchFile");
export const unwatchFile = makeStub("unwatchFile");
export const createReadStream = makeStub("createReadStream");
export const createWriteStream = makeStub("createWriteStream");
export const appendFile = makeStub("appendFile");
export const appendFileSync = makeStub("appendFileSync");
export const truncate = makeStub("truncate");
export const truncateSync = makeStub("truncateSync");
export const chmod = makeStub("chmod");
export const chmodSync = makeStub("chmodSync");
export const chown = makeStub("chown");
export const chownSync = makeStub("chownSync");

// worker_threads
export const Worker = makeStub("Worker");
export const isMainThread = true;
export const parentPort = null;
export const workerData = undefined;
export const threadId = 0;
export const MessageChannel = makeStub("MessageChannel");
export const MessagePort = makeStub("MessagePort");
export const BroadcastChannel = makeStub("BroadcastChannel");

// child_process
export const fork = makeStub("fork");

// os
export const EOL = "\n";
export const endianness = () => "LE" as const;
export const loadavg = () => [0, 0, 0];
export const uptime = () => 0;
export const setPriority = () => {};
export const getPriority = () => 0;
