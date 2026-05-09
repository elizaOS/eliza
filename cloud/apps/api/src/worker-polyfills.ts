/**
 * Local `wrangler dev` (workerd) + `nodejs_compat` may load undici/fetch shims that
 * reference the Web IDL globals `MessagePort` / `MessageChannel` before workerd wires
 * them. Without these, module init throws: ReferenceError: MessagePort is not defined.
 *
 * Some dependency code also expects `FinalizationRegistry` (V8) during init; workerd
 * may not expose it globally in all dev builds.
 *
 * Lexical `__dirname` / `__filename` in some transitive CJS shims are replaced at
 * bundle time via `wrangler.toml` `[define]`.
 *
 * Production Workers typically already expose messaging globals; we only polyfill
 * when missing.
 */
class MessagePortPolyfill {
  postMessage(_message: object | null, _transfer?: Iterable<object>): void {}
  close(): void {}
  start(): void {}
}

class MessageChannelPolyfill {
  readonly port1: MessagePortPolyfill;
  readonly port2: MessagePortPolyfill;
  constructor() {
    this.port1 = new MessagePortPolyfill();
    this.port2 = new MessagePortPolyfill();
  }
}

/** No-op FinalizationRegistry for runtimes where the V8 builtin is unavailable. */
class FinalizationRegistryPolyfill {
  constructor(_cleanup: (heldValue: object) => void) {}
  register(_target: object, _heldValue: object, _unregisterToken?: object): void {}
  unregister(_unregisterToken: object): void {}
}

const root = globalThis as unknown as {
  MessagePort?: unknown;
  MessageChannel?: unknown;
  FinalizationRegistry?: unknown;
};

if (root.MessagePort === undefined) {
  root.MessagePort = MessagePortPolyfill;
}
if (root.MessageChannel === undefined) {
  root.MessageChannel = MessageChannelPolyfill;
}
if (root.FinalizationRegistry === undefined) {
  root.FinalizationRegistry = FinalizationRegistryPolyfill;
}
