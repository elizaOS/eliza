/**
 * Direct unit coverage for the browser-build empty-module alias
 * (`empty-node-module`). Drives the real stub: Node stream helpers, WHATWG
 * stream globals, `util/types` isX guards, empty collection aliases, typed
 * noop return shapes, and the catch-all default Proxy (apply, prototype
 * vs missing-key get, ownKeys, existing vs fallback descriptors). No mocks
 * of the module under test.
 */
import { describe, expect, it } from "vitest";
import emptyNodeModule, * as stub from "./empty-node-module";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  CONNECTOR_ENV_MAP,
  CORE_PLUGINS,
  CUSTOM_PLUGINS_DIRNAME,
  computeNextCronRunAtMs,
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
  EMBEDDING_PRESETS,
  extractCompatTextContent,
  finished,
  gatePluginSessionForHostedApp,
  getAgentEventService,
  getDocumentsService,
  getDocumentsServiceTimeoutMs,
  getPluginWidgets,
  getWalletAddresses,
  hasOwnerAccess,
  isAnyArrayBuffer,
  isArrayBufferView,
  isAsyncFunction,
  isDate,
  isMap,
  isNativeError,
  isPromise,
  isRegExp,
  isSet,
  isTypedArray,
  OPTIONAL_CORE_PLUGINS,
  pipeline,
  ReadableStream,
  resolveOAuthDir,
  resolveOwnerEntityId,
  TransformStream,
  validatePluginConfig,
  WritableStream,
} from "./empty-node-module";

const EMPTY_ARRAY_EXPORTS = {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  CONNECTOR_ENV_MAP,
  CORE_PLUGINS,
  CUSTOM_PLUGINS_DIRNAME,
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
  EMBEDDING_PRESETS,
  OPTIONAL_CORE_PLUGINS,
} as const;

const FALSE_NOOPS = {
  isAnyArrayBuffer,
  isArrayBufferView,
  isAsyncFunction,
  isDate,
  isMap,
  isNativeError,
  isPromise,
  isRegExp,
  isSet,
  isTypedArray,
} as const;

const EMPTY_ARRAY_KEYS = new Set(Object.keys(EMPTY_ARRAY_EXPORTS));
const FALSE_NOOP_KEYS = new Set(Object.keys(FALSE_NOOPS));
const ASYNC_NOOP_KEYS = new Set(["pipeline", "finished"]);
const STREAM_KEYS = new Set([
  "ReadableStream",
  "WritableStream",
  "TransformStream",
]);
const SPECIAL_KEYS = new Set([
  "default",
  "getPluginWidgets",
  "validatePluginConfig",
  "computeNextCronRunAtMs",
  "extractCompatTextContent",
  "gatePluginSessionForHostedApp",
  "getAgentEventService",
  "getDocumentsService",
  "getDocumentsServiceTimeoutMs",
  "getWalletAddresses",
  "hasOwnerAccess",
  "resolveOAuthDir",
  "resolveOwnerEntityId",
]);

function isCallable(value: unknown): value is () => unknown {
  return typeof value === "function";
}

describe("empty-node-module stream aliases", () => {
  it("re-exports the WHATWG stream constructors from globalThis", () => {
    expect(ReadableStream).toBe(globalThis.ReadableStream);
    expect(WritableStream).toBe(globalThis.WritableStream);
    expect(TransformStream).toBe(globalThis.TransformStream);
  });

  it("resolves pipeline and finished to undefined regardless of arguments", async () => {
    await expect(pipeline()).resolves.toBeUndefined();
    await expect(finished()).resolves.toBeUndefined();
    await expect(
      Function.prototype.call.call(pipeline, undefined, {}, () => undefined),
    ).resolves.toBeUndefined();
    await expect(
      Function.prototype.call.call(finished, undefined, {}, () => undefined),
    ).resolves.toBeUndefined();
  });
});

describe("empty-node-module util/types guards", () => {
  it("returns false for every isX guard, including real matching values", () => {
    const matchingValues = {
      isAnyArrayBuffer: new ArrayBuffer(4),
      isArrayBufferView: new Uint8Array(1),
      isAsyncFunction: async () => undefined,
      isDate: new Date(),
      isMap: new Map(),
      isNativeError: new Error("sample"),
      isPromise: Promise.resolve(null),
      isRegExp: /x/,
      isSet: new Set(),
      isTypedArray: new Uint8Array(1),
    } as const;

    for (const [name, guard] of Object.entries(FALSE_NOOPS)) {
      expect(guard(), name).toBe(false);
      const sample = matchingValues[name as keyof typeof matchingValues];
      expect(
        Function.prototype.call.call(guard, undefined, sample),
        `${name}(matching value)`,
      ).toBe(false);
    }
  });
});

describe("empty-node-module empty collection aliases", () => {
  it("exports a distinct empty array for each collection alias", () => {
    const arrays = Object.values(EMPTY_ARRAY_EXPORTS);
    for (const [name, value] of Object.entries(EMPTY_ARRAY_EXPORTS)) {
      expect(Array.isArray(value), name).toBe(true);
      expect(value, name).toEqual([]);
      expect(value.length, name).toBe(0);
    }
    for (let i = 0; i < arrays.length; i += 1) {
      for (let j = i + 1; j < arrays.length; j += 1) {
        expect(arrays[i]).not.toBe(arrays[j]);
      }
    }
  });
});

describe("empty-node-module typed stubs", () => {
  it("returns a fresh empty list from getPluginWidgets", () => {
    const first = getPluginWidgets();
    const second = getPluginWidgets();
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(first).not.toBe(second);
  });

  it("returns a shallow-frozen unconfigured plugin-config result", () => {
    const result = validatePluginConfig();
    expect(result).toEqual({
      configured: false,
      errors: [],
      warnings: [],
      maskedValue: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { configured: boolean }).configured = true;
    }).toThrow(TypeError);
    expect(result.configured).toBe(false);
  });

  it("returns the typed empty scalars and nulls from the extra agent aliases", () => {
    expect(computeNextCronRunAtMs()).toBe(0);
    expect(extractCompatTextContent()).toBe("");
    expect(getAgentEventService()).toBeNull();
    expect(getDocumentsService()).toBeNull();
    expect(getDocumentsServiceTimeoutMs()).toBe(0);
    expect(hasOwnerAccess()).toBe(false);
    expect(resolveOAuthDir()).toBe("");
    expect(resolveOwnerEntityId()).toBe("");
  });

  it("returns a fresh frozen empty wallet-address record", () => {
    const first = getWalletAddresses();
    const second = getWalletAddresses();
    expect(first).toEqual({});
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(() => {
      (first as { solana?: string }).solana = "addr";
    }).toThrow(TypeError);
  });

  it("returns the same plugin reference from gatePluginSessionForHostedApp", () => {
    const plugin = { id: "plugin-browser" };
    expect(gatePluginSessionForHostedApp(plugin)).toBe(plugin);
    expect(gatePluginSessionForHostedApp("keep")).toBe("keep");
    expect(gatePluginSessionForHostedApp(null)).toBeNull();
  });
});

describe("empty-node-module remaining named noops", () => {
  it("returns undefined from every leftover function export", () => {
    for (const [name, value] of Object.entries(stub)) {
      if (
        EMPTY_ARRAY_KEYS.has(name) ||
        FALSE_NOOP_KEYS.has(name) ||
        ASYNC_NOOP_KEYS.has(name) ||
        STREAM_KEYS.has(name) ||
        SPECIAL_KEYS.has(name)
      ) {
        continue;
      }
      expect(isCallable(value), name).toBe(true);
      if (!isCallable(value)) {
        throw new Error(`expected ${name} to be a function stub`);
      }
      expect(value(), name).toBeUndefined();
    }
  });
});

describe("empty-node-module default Proxy", () => {
  it("applies as a noop and ignores arguments", () => {
    expect(emptyNodeModule()).toBeUndefined();
    expect(
      Function.prototype.call.call(emptyNodeModule, undefined, "arg", {
        nested: true,
      }),
    ).toBeUndefined();
  });

  it("returns the shared noop for missing keys and undefined for prototype", () => {
    const viaGet = Reflect.get(emptyNodeModule, "missingKey");
    expect(typeof viaGet).toBe("function");
    expect(isCallable(viaGet) ? viaGet() : viaGet).toBeUndefined();
    expect(Reflect.get(emptyNodeModule, "otherKey")).toBe(viaGet);
    expect(Reflect.get(emptyNodeModule, "prototype")).toBeUndefined();
  });

  it("does not advertise missing keys through `in` (no has trap)", () => {
    expect(Reflect.has(emptyNodeModule, "length")).toBe(true);
    expect(Reflect.has(emptyNodeModule, "name")).toBe(true);
    expect(Reflect.has(emptyNodeModule, "missingKey")).toBe(false);
  });

  it("exposes the target function ownKeys and existing descriptors", () => {
    expect(Reflect.ownKeys(emptyNodeModule)).toEqual(["length", "name"]);
    expect(Object.getOwnPropertyDescriptor(emptyNodeModule, "length")).toEqual({
      value: 0,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(emptyNodeModule, "name")).toEqual({
      value: "noop",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  });

  it("falls back to a non-enumerable noop descriptor for missing keys, including prototype", () => {
    const missing = Object.getOwnPropertyDescriptor(
      emptyNodeModule,
      "missingKey",
    );
    const viaGet = Reflect.get(emptyNodeModule, "missingKey");
    expect(missing).toEqual({
      configurable: true,
      enumerable: false,
      value: viaGet,
      writable: true,
    });

    const prototypeDescriptor = Object.getOwnPropertyDescriptor(
      emptyNodeModule,
      "prototype",
    );
    expect(prototypeDescriptor).toEqual({
      configurable: true,
      enumerable: false,
      value: viaGet,
      writable: true,
    });
    expect(Reflect.get(emptyNodeModule, "prototype")).toBeUndefined();
  });

  it("rejects construct because the proxy target is an arrow function", () => {
    const ctor = emptyNodeModule as unknown as new () => unknown;
    expect(() => new ctor()).toThrow(TypeError);
  });
});
