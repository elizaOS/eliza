import path from "node:path";
import type { Plugin } from "vite";

/**
 * Generate a virtual ESM module that stubs all exports of a Node built-in.
 * We `require()` the real module at Vite config time (Node process), read its
 * export names, and emit matching no-op stubs so esbuild's static import
 * analysis succeeds.  At runtime these stubs are never meaningfully called
 * because the server-only code paths that use them are never executed in the
 * browser.
 */
export function generateNodeBuiltinStub(
  moduleId: string,
  req: NodeRequire,
): string {
  const bareModule = moduleId.replace(/^node:/, "");
  const lines = [
    // noop: returns itself (for chained calls like createRequire(url)(id)),
    // and is a valid class base (so `class X extends noop` works).
    "function noop() { return noop; }",
    "const asyncNoop = () => Promise.resolve();",
    "const handler = { get(t, p) { if (typeof p === 'symbol') return undefined; if (p === '__esModule') return true; if (p === 'default') return t; if (p === 'prototype') return {}; return noop; }, has() { return true; }, ownKeys() { return []; }, getOwnPropertyDescriptor() { return { configurable: true, enumerable: true }; } };",
    "const stub = new Proxy({}, handler);",
    "export default stub;",
  ];

  let exportNames: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const real = req(bareModule);
    exportNames = Object.keys(real).filter(
      (k) => !k.startsWith("_") && k !== "default",
    );
  } catch {
    // Module not available (e.g. dns/promises on some platforms)
  }

  const reserved = new Set([
    "default",
    "arguments",
    "eval",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
  ]);

  for (const name of exportNames) {
    if (reserved.has(name)) continue;
    // Validate it's a valid JS identifier
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) continue;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const real = req(bareModule);
      const val = real[name];
      if (typeof val === "function") {
        if (
          /^[A-Z]/.test(name) &&
          val.prototype &&
          Object.getOwnPropertyNames(val.prototype).length > 1
        ) {
          lines.push(`export class ${name} { constructor() {} }`);
        } else {
          lines.push(`export const ${name} = noop;`);
        }
      } else if (typeof val === "object" && val !== null) {
        // For objects like fs.constants, promises, etc. — wrap in Proxy
        lines.push(`export const ${name} = new Proxy({}, handler);`);
      } else if (typeof val === "string") {
        lines.push(`export const ${name} = ${JSON.stringify(val)};`);
      } else if (typeof val === "number" || typeof val === "boolean") {
        lines.push(`export const ${name} = ${val};`);
      } else {
        lines.push(`export const ${name} = undefined;`);
      }
    } catch {
      lines.push(`export const ${name} = noop;`);
    }
  }

  return lines.join("\n");
}

/**
 * Dev-mode plugin that stubs native-only packages.  In production builds
 * rollupOptions.external handles this, but the Vite dev server still tries
 * to resolve + serve excluded deps.  This plugin intercepts the import at
 * the resolveId stage and returns an empty virtual module so Vite never
 * touches the real CJS files (which fail ESM named-export checks).
 */
export interface NativeModuleStubPluginOptions {
  isCapacitorMobileBuild: boolean;
  requireModule: NodeRequire;
}

export function nativeModuleStubPlugin(
  options: NativeModuleStubPluginOptions,
): Plugin {
  const { isCapacitorMobileBuild, requireModule } = options;
  const VIRTUAL_PREFIX = "\0native-stub:";
  // Packages that only run on the server / desktop and must never be
  // parsed by Vite's dev pipeline.
  const nativePackages = new Set([
    "node-llama-cpp",
    "fs-extra",
    "pty-state-capture",
    "pty-console",
    "electron",
    "undici",
    // Image native bindings — never load in the renderer; if a server-only
    // import leaks into the client graph, stub instead of bundling sharp.js.
    "sharp",
    // Browser automation is server-only. If a mixed entrypoint leaks one of
    // these packages into the renderer graph, stub it instead of letting Vite
    // prebundle proxy-agent and other Node-only HTTP deps for the browser.
    "puppeteer-core",
    "@puppeteer/browsers",
    // Server-only plugins statically imported from the @elizaos/agent runtime.
    // Their exports maps nest browser/node conditional exports that Vite 6's
    // commonjs--resolver cannot walk. Stubbing returns an empty Proxy virtual
    // module so the browser bundle never tries to execute server-only code.
    "@elizaos/plugin-local-embedding",
    "@elizaos/plugin-anthropic",
    "@elizaos/plugin-pdf",
    "@elizaos/plugin-sql",
    "@elizaos/plugin-agent-skills",
    "@elizaos/plugin-agent-orchestrator",
    "@elizaos/plugin-signal",
    "@elizaos/plugin-telegram",
    "@elizaos/plugin-whatsapp",
    "@protobufjs/inquire",
  ]);
  if (!isCapacitorMobileBuild) {
    // Mobile-only Capacitor llama.cpp runtime. Web/Electrobun builds stub it,
    // but iOS/Android builds must ship its JS bridge so the native plugin can
    // register through @capacitor/core.
    nativePackages.add("llama-cpp-capacitor");
  }
  const nativeScopeRe = /^@node-llama-cpp\//;
  // Capacitor native plugins — mobile-only, must never run in the browser.
  // Stubbing prevents Rollup from failing when bun workspaces don't hoist them.
  const capacitorNativeScopeRe = /^@capacitor\/(?!core)(.+)$/;

  return {
    name: "native-module-stub",
    enforce: "pre",
    resolveId(id) {
      // Intercept ALL node: builtins before Vite externalizes them.
      // The @elizaos/core node entry uses many Node APIs (crypto, fs, module,
      // etc.) at the top level.  Rather than stubbing each one individually,
      // we return a Proxy-based virtual module for any node: import.
      if (id.startsWith("node:")) return VIRTUAL_PREFIX + id;
      // Also catch bare imports of Node builtins that get resolved differently
      const nodeBuiltins = new Set([
        "module",
        "crypto",
        "fs",
        "path",
        "os",
        "url",
        "util",
        "stream",
        "http",
        "https",
        "net",
        "tls",
        "zlib",
        "child_process",
        "worker_threads",
        "perf_hooks",
        "async_hooks",
        "dns",
        "dgram",
        "readline",
        "tty",
        "cluster",
        "v8",
        "vm",
        "assert",
        "buffer",
        "constants",
        "events",
        "string_decoder",
        "querystring",
        "punycode",
      ]);
      if (nodeBuiltins.has(id) || nodeBuiltins.has(id.split("/")[0]))
        return `${VIRTUAL_PREFIX}node:${id}`;
      const bare = id.startsWith("@")
        ? id.split("/").slice(0, 2).join("/")
        : id.split("/")[0];
      // Scoped: @node-llama-cpp/*
      if (nativeScopeRe.test(id)) return VIRTUAL_PREFIX + id;
      // Capacitor native plugins (@capacitor/* except @capacitor/core)
      if (capacitorNativeScopeRe.test(id) && !isCapacitorMobileBuild) {
        return VIRTUAL_PREFIX + id;
      }
      // sharp's optional platform packages (@img/sharp-wasm32, etc.)
      if (
        id.startsWith("@img/sharp") ||
        id.replace(/\\/g, "/").includes("/@img/sharp")
      )
        return VIRTUAL_PREFIX + id;
      // @napi-rs/keyring + optional platform packs (@napi-rs/keyring-darwin-arm64, …).
      // Vite dependency optimization tries to parse .node binaries as UTF-8 and crashes.
      if (
        /^@napi-rs\/keyring/.test(id) ||
        id.replace(/\\/g, "/").includes("/@napi-rs/keyring")
      ) {
        return `${VIRTUAL_PREFIX}@napi-rs/keyring`;
      }
      // Exact or sub-path match against native packages
      if (nativePackages.has(bare)) return VIRTUAL_PREFIX + id;
      return null;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;

      const strippedId = id.slice(VIRTUAL_PREFIX.length);
      const modName = strippedId.split("/")[0];
      // node-llama-cpp is the most import-heavy native module — its consumers
      // use many named exports (LlamaLogLevel, getLlama, etc.).  Return a
      // module whose default export is a Proxy that returns no-op stubs for
      // any property access, AND re-export that proxy as every known name so
      // static `import { X }` statements resolve without error.
      if (modName === "node-llama-cpp") {
        return [
          "const handler = { get: (_, p) => (p === Symbol.toPrimitive ? () => 0 : typeof p === 'string' ? (() => {}) : undefined) };",
          "const stub = new Proxy({}, handler);",
          "export default stub;",
          // Known named exports used by @elizaos/plugin-local-embedding and
          // other consumers — extend as needed:
          "export const getLlama = () => Promise.resolve(stub);",
          "export const LlamaLogLevel = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });",
          "export const Llama = stub;",
          "export const LlamaModel = stub;",
          "export const LlamaEmbeddingContext = stub;",
          "export const LlamaContext = stub;",
          "export const LlamaChatSession = stub;",
          "export const LlamaGrammar = stub;",
          "export const LlamaJsonSchemaGrammar = stub;",
        ].join("\n");
      }

      // fs-extra: CJS module with default + named exports
      if (modName === "fs-extra") {
        return [
          "const noop = () => {};",
          "const stub = new Proxy({}, { get: () => noop });",
          "export default stub;",
          // Re-export common fs-extra named exports so static imports work:
          ...[
            "copy",
            "copySync",
            "move",
            "moveSync",
            "remove",
            "removeSync",
            "ensureDir",
            "ensureDirSync",
            "ensureFile",
            "ensureFileSync",
            "mkdirs",
            "mkdirsSync",
            "readJson",
            "readJsonSync",
            "writeJson",
            "writeJsonSync",
            "pathExists",
            "pathExistsSync",
            "outputFile",
            "outputFileSync",
            "outputJson",
            "outputJsonSync",
            "emptyDir",
            "emptyDirSync",
          ].map((n) => `export const ${n} = noop;`),
        ].join("\n");
      }

      // events: CJS module, consumers use `import { EventEmitter } from "events"`
      if (modName === "events") {
        return [
          "function EventEmitter() {}",
          "EventEmitter.prototype.on = function() { return this; };",
          "EventEmitter.prototype.off = function() { return this; };",
          "EventEmitter.prototype.emit = function() { return false; };",
          "EventEmitter.prototype.addListener = EventEmitter.prototype.on;",
          "EventEmitter.prototype.removeListener = EventEmitter.prototype.off;",
          "export { EventEmitter };",
          "export default EventEmitter;",
        ].join("\n");
      }

      // undici: Node HTTP client — re-export browser globals (fetch, WebSocket, etc.)
      if (modName === "undici") {
        return [
          "export const fetch = globalThis.fetch;",
          "export const Request = globalThis.Request;",
          "export const Response = globalThis.Response;",
          "export const Headers = globalThis.Headers;",
          "export const FormData = globalThis.FormData;",
          "export const WebSocket = globalThis.WebSocket;",
          "export const EventSource = globalThis.EventSource || class {};",
          "export const AbortController = globalThis.AbortController;",
          "export const File = globalThis.File;",
          "export const Blob = globalThis.Blob;",
          "export class Agent {}",
          "export class Pool {}",
          "export class Client {}",
          "export class Dispatcher {}",
          "export const setGlobalDispatcher = () => {};",
          "export const getGlobalDispatcher = () => ({});",
          "export default { fetch, Request, Response, Headers, WebSocket };",
        ].join("\n");
      }

      // async_hooks — AsyncLocalStorage must be a real constructor because
      // @elizaos packages do `new AsyncLocalStorage()` at the
      // top level. Uses function-constructor syntax (not class expressions)
      // for maximum WebView compatibility. The renderChunk plugin
      // (asyncLocalStoragePatchPlugin) also patches the final bundle output
      // as a safety net for patterns inlined by Rollup.
      if (modName === "node:async_hooks" || modName === "async_hooks") {
        return [
          "function AsyncLocalStorage() {} AsyncLocalStorage.prototype.getStore = function() { return undefined; }; AsyncLocalStorage.prototype.run = function(store, fn) { return fn.apply(void 0, [].slice.call(arguments, 2)); }; AsyncLocalStorage.prototype.enterWith = function() {}; AsyncLocalStorage.prototype.disable = function() {};",
          "export { AsyncLocalStorage };",
          "export function executionAsyncId() { return 0; }",
          "export function triggerAsyncId() { return 0; }",
          "export function executionAsyncResource() { return {}; }",
          "function AsyncResource() {} AsyncResource.prototype.runInAsyncScope = function(fn) { return fn.apply(void 0, [].slice.call(arguments, 1)); }; AsyncResource.prototype.emitDestroy = function() { return this; }; AsyncResource.prototype.asyncId = function() { return 0; }; AsyncResource.prototype.triggerAsyncId = function() { return 0; };",
          "export { AsyncResource };",
          "export function createHook() { return { enable: function(){}, disable: function(){} }; }",
          "export default { AsyncLocalStorage: AsyncLocalStorage, AsyncResource: AsyncResource, executionAsyncId: executionAsyncId, triggerAsyncId: triggerAsyncId, executionAsyncResource: executionAsyncResource, createHook: createHook };",
        ].join("\n");
      }

      // node:* builtins — return a Proxy-based module that provides any
      // named export as a no-op function.  This handles @elizaos/core's node
      // entry which uses createRequire, randomUUID, fs, etc. at the top level.
      if (modName.startsWith("node:")) {
        // Dynamic: read the real Node module's export names at config time
        // and generate matching no-op stubs so esbuild's static analysis passes.
        return generateNodeBuiltinStub(
          id.slice(VIRTUAL_PREFIX.length),
          requireModule,
        );
      }

      if (strippedId === "@napi-rs/keyring") {
        return [
          "// Stub: real binding is native-only (@elizaos/vault master key / OS keychain).",
          "export class Entry {",
          "  constructor(_service, _account) {}",
          '  getPassword() { return ""; }',
          "  setPassword() {",
          "    throw new Error(",
          '      "OS keychain is unavailable in the browser/renderer build."',
          "    );",
          "  }",
          "}",
        ].join("\n");
      }

      // libvips native / wasm bindings — only used server-side for LifeOps screen sampling
      if (
        strippedId === "sharp" ||
        strippedId.startsWith("sharp/") ||
        strippedId.startsWith("@img/sharp")
      ) {
        return [
          "function mk() {",
          "  const c = {",
          "    rotate() { return c; },",
          "    resize() { return c; },",
          "    greyscale() { return c; },",
          "    png() { return c; },",
          "    jpeg() { return c; },",
          "    async toBuffer() { return new Uint8Array(0); },",
          "    async raw() { return { data: new Uint8Array(0), info: { width: 1, height: 1, channels: 1 } }; },",
          "  };",
          "  return c;",
          "}",
          "export default function sharp() { return mk(); }",
        ].join("\n");
      }

      if (strippedId === "@elizaos/plugin-sql") {
        return [
          "const handler = { get: () => table, apply: () => table };",
          "const table = new Proxy(function table() {}, handler);",
          ...[
            "agentTable",
            "approvalRequestTable",
            "authAuditEventTable",
            "authBootstrapJtiSeenTable",
            "authIdentityCreatedAtDefault",
            "authIdentityTable",
            "authOwnerBindingTable",
            "authOwnerLoginTokenTable",
            "authSessionTable",
            "cacheTable",
            "channelTable",
            "channelParticipantsTable",
            "componentTable",
            "embeddingTable",
            "entityTable",
            "entityIdentityTable",
            "entityMergeCandidateTable",
            "factCandidateTable",
            "logTable",
            "longTermMemories",
            "memoryTable",
            "memoryAccessLogs",
            "messageTable",
            "messageServerTable",
            "messageServerAgentsTable",
            "pairingAllowlistTable",
            "pairingRequestTable",
            "participantTable",
            "relationshipTable",
            "roomTable",
            "serverTable",
            "sessionSummaries",
            "taskTable",
            "worldTable",
          ].map((name) => `export const ${name} = table;`),
          ...[
            "and",
            "asc",
            "count",
            "desc",
            "eq",
            "gt",
            "gte",
            "inArray",
            "isNull",
            "lt",
            "lte",
            "ne",
            "or",
            "sql",
          ].map((name) => `export const ${name} = table;`),
          "export const schema = table;",
          "export default table;",
        ].join("\n");
      }

      if (strippedId === "@protobufjs/inquire") {
        return [
          "function inquire() { return null; }",
          "export { inquire };",
          "export default inquire;",
        ].join("\n");
      }

      if (strippedId === "@elizaos/plugin-telegram") {
        return [
          "function serverOnly() { throw new Error('Telegram account auth is server-only'); }",
          "export function defaultTelegramAccountDeviceModel() { return 'Eliza Desktop'; }",
          "export function defaultTelegramAccountSystemVersion() { return 'browser'; }",
          "export function loadTelegramAccountSessionString() { return serverOnly(); }",
          "export class TelegramAccountAuthSession {",
          "  constructor() { serverOnly(); }",
          "}",
          "export default { defaultTelegramAccountDeviceModel, defaultTelegramAccountSystemVersion, loadTelegramAccountSessionString, TelegramAccountAuthSession };",
        ].join("\n");
      }

      // Capacitor native plugins — mobile-only, cloud builds stub them.
      // Must export the exact named identifiers used in app-core sources.
      if (capacitorNativeScopeRe.test(strippedId)) {
        const capPkg = strippedId.split("/").slice(0, 2).join("/");
        if (capPkg === "@capacitor/haptics") {
          return [
            "const noop = () => {};const noopObj = new Proxy({}, { get: () => noop });",
            "export const Haptics = noopObj;",
            "export const ImpactStyle = Object.freeze({ Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' });",
            "export const NotificationType = Object.freeze({ Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' });",
            "export default noopObj;",
          ].join("\n");
        }
        if (capPkg === "@capacitor/keyboard") {
          return [
            "const noop = () => {};const noopObj = new Proxy({}, { get: () => noop });",
            "export const Keyboard = noopObj;",
            "export default noopObj;",
          ].join("\n");
        }
        if (capPkg === "@capacitor/preferences") {
          return [
            "const noop = () => Promise.resolve({ value: null });const noopObj = new Proxy({}, { get: () => noop });",
            "export const Preferences = noopObj;",
            "export default noopObj;",
          ].join("\n");
        }
        if (capPkg === "@capacitor/push-notifications") {
          return [
            "const asyncNoop = async () => {};",
            "const listenerHandle = { remove: asyncNoop };",
            "export const PushNotifications = {",
            "  requestPermissions: async () => ({ receive: 'denied' }),",
            "  addListener: async () => listenerHandle,",
            "  register: asyncNoop,",
            "  removeAllListeners: asyncNoop,",
            "};",
            "export default PushNotifications;",
          ].join("\n");
        }
        if (capPkg === "@capacitor/barcode-scanner") {
          return [
            "const asyncNoop = async () => ({ ScanResult: '' });",
            "export const CapacitorBarcodeScanner = { scanBarcode: asyncNoop };",
            "export const CapacitorBarcodeScannerTypeHint = Object.freeze({ QR_CODE: 'QR_CODE' });",
            "export default CapacitorBarcodeScanner;",
          ].join("\n");
        }
        // Generic Capacitor plugin stub
        return [
          "const noop = () => {};const stub = new Proxy({}, { get: () => noop });",
          "export default stub;",
        ].join("\n");
      }

      // Generic fallback for other native modules
      return "export default {};\n";
    },
    // Patch @elizaos/core browser entry at transform time to add missing
    // exports and fix browser-incompatible patterns.
    transform(code, id) {
      const isCoreDistFile =
        id.endsWith("index.browser.js") || id.endsWith("index.node.js");
      const normId = id.split(path.sep).join("/");
      const isCorePackagePath =
        normId.includes("/node_modules/@elizaos/core/") ||
        normId.includes("packages/core/dist/");
      if (!isCoreDistFile || !isCorePackagePath) return null;

      // Fix AsyncLocalStorage: the browser entry has a try/catch that does
      //   let {AsyncLocalStorage:$} = (() => {throw new Error(...)})()
      // Rollup/esbuild may optimize the throw into (()=>({})) which makes
      // AsyncLocalStorage undefined, causing "xte is not a constructor".
      // Replace the broken IIFE pattern with a working stub class.
      const patched = code.replace(
        /\(\(\)\s*=>\s*\{\s*throw\s+new\s+Error\(\s*"Cannot require module "\s*\+\s*"node:async_hooks"\s*\)\s*;\s*\}\)\(\)/g,
        "(function(){function A(){} A.prototype.getStore=function(){return undefined};A.prototype.run=function(s,fn){return fn.apply(void 0,[].slice.call(arguments,2))};A.prototype.enterWith=function(){};A.prototype.disable=function(){};return{AsyncLocalStorage:A}})()",
      );
      // Names that downstream plugins and the agent runtime
      // import from @elizaos/core but that are missing from the browser entry.
      const missingExports: Record<string, string> = {
        resolveSecretKeyAlias: "function(k){return k}",
        SECRET_KEY_ALIASES: "{}",
        OnboardingStateMachine: "function(){}",
        isOnboardingComplete: "function(){return false}",
        AgentEventService: "function(){}",
        AutonomyService: "function(){}",
        createBasicCapabilitiesPlugin: "function(){return{name:'stub'}}",
        resolveStateDir: "function(){return '/.eliza'}",
        runPluginMigrations: "async function(){}",
      };
      // Check which are actually missing from the existing export block
      const needed = Object.keys(missingExports).filter((n) => {
        // Check if already exported (as named export or re-export alias)
        const exportedAs = new RegExp(`\\b${n}\\b`);
        // Search only in export{} blocks
        const exportBlocks = patched.match(/export\s*\{[^}]+\}/g) || [];
        return !exportBlocks.some((b) => exportedAs.test(b));
      });
      if (needed.length === 0 && patched === code) return null;
      // Use unique prefixed names to avoid collisions with minified vars
      const prefix = "__eliza_stub_";
      const stubs = needed
        .map((n) => `var ${prefix}${n} = ${missingExports[n]};`)
        .join("\n");
      const exports =
        needed.length > 0
          ? `export { ${needed.map((n) => `${prefix}${n} as ${n}`).join(", ")} };`
          : "";
      return { code: `${patched}\n${stubs}\n${exports}`, map: null };
    },
  };
}
