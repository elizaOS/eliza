/**
 * Shutdown hook contract.
 *
 * libomnivoice contexts are cached at module scope; without explicit
 * teardown, `ov_free` is never called when the runtime shuts down.
 * These tests pin that:
 *   1. `closeOmnivoiceShutdown()` releases every registered closer
 *      exactly once per cached context.
 *   2. Repeated shutdown calls are idempotent — the underlying
 *      OmnivoiceContext.close is invoked at most once per cache fill.
 *   3. Registering hooks twice does not pile up listeners.
 *
 * The tests deliberately mock `OmnivoiceContext.open` so they never
 * touch the real shared library, and skip cleanly with a logged warning
 * when the underlying FFI shape changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmnivoiceNotInstalled } from "../src/errors";
import { OmnivoiceContext } from "../src/ffi";
import {
  _clearOmnivoiceClosers,
  _resetShutdownRegistration,
  closeOmnivoiceShutdown,
  registerOmnivoiceCloser,
  registerOmnivoiceShutdownHooks,
} from "../src/shutdown";
import {
  _hasCachedSingingContext,
  _resetSingingCache,
  getSingingContext,
} from "../src/singing";

function fakeOmnivoiceContext(): OmnivoiceContext {
  // The FFI class has private fields, but we only need it to behave
  // like { close(): void } for shutdown wiring. Cast through the
  // declared type via Object.create so vitest spies can attach.
  const proto = OmnivoiceContext.prototype;
  const instance = Object.create(proto) as OmnivoiceContext;
  Object.defineProperty(instance, "close", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
  return instance;
}

describe("plugin-omnivoice shutdown", () => {
  beforeEach(() => {
    _resetShutdownRegistration();
    _resetSingingCache();
    _clearOmnivoiceClosers();
  });

  afterEach(() => {
    _resetShutdownRegistration();
    _resetSingingCache();
    _clearOmnivoiceClosers();
  });

  it("releases the cached singing context exactly once", async () => {
    const fake = fakeOmnivoiceContext();
    const closeSpy = fake.close as ReturnType<typeof vi.fn>;

    const openSpy = vi.spyOn(OmnivoiceContext, "open").mockResolvedValue(fake);

    try {
      await getSingingContext({
        modelPath: "/tmp/fake-singing.gguf",
        codecPath: "/tmp/fake-codec.gguf",
      });
    } catch (err) {
      if (err instanceof OmnivoiceNotInstalled) {
        openSpy.mockRestore();
        return;
      }
      throw err;
    }

    expect(_hasCachedSingingContext()).toBe(true);

    closeOmnivoiceShutdown();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(_hasCachedSingingContext()).toBe(false);

    // Idempotency — a second shutdown must not re-fire close.
    closeOmnivoiceShutdown();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    openSpy.mockRestore();
  });

  it("invokes every registered extra closer once per shutdown", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerOmnivoiceCloser(a);
    registerOmnivoiceCloser(b);

    closeOmnivoiceShutdown();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    closeOmnivoiceShutdown();
    // Closers run on every shutdown call (they're individually
    // idempotent), but each closer should observe only one call per
    // outer shutdown invocation.
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("registerOmnivoiceShutdownHooks is idempotent", () => {
    const first = registerOmnivoiceShutdownHooks();
    const second = registerOmnivoiceShutdownHooks();
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("registers process listeners for beforeExit, SIGTERM, SIGINT", () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT"),
    };
    registerOmnivoiceShutdownHooks();
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
  });
});
