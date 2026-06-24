import { describe, expect, it } from "bun:test";
import {
  createGlobalSingleton,
  createPortSingleton,
  createSingleton,
} from "../../shared/src/utils/singleton";

/**
 * Singleton helpers prevent double-initialization of server instances. The
 * port-aware variant must only return an instance when the requested port
 * matches — otherwise two servers could bind the same port.
 */

describe("createSingleton", () => {
  it("get/set/clear an in-memory instance", () => {
    const s = createSingleton<{ id: number }>();
    expect(s.getInstance()).toBeNull();
    s.setInstance({ id: 1 });
    expect(s.getInstance()).toEqual({ id: 1 });
    s.clearInstance();
    expect(s.getInstance()).toBeNull();
  });
});

describe("createGlobalSingleton", () => {
  it("persists via a unique global key", () => {
    const s = createGlobalSingleton<string>("__test_singleton_global_key");
    expect(s.getInstance()).toBeNull();
    s.setInstance("server");
    expect(s.getInstance()).toBe("server");
    s.clearInstance();
    expect(s.getInstance()).toBeNull();
  });
});

describe("createPortSingleton", () => {
  it("only returns the instance when the requested port matches", () => {
    const s = createPortSingleton<string>("__test_port_singleton_x");
    s.setInstance("ws-server", 8080);
    expect(s.getInstance()).toBe("ws-server"); // no port → return existing
    expect(s.getInstance(8080)).toBe("ws-server"); // matching port
    expect(s.getInstance(9090)).toBeNull(); // mismatched port → null
    s.clearInstance();
    expect(s.getInstance(8080)).toBeNull();
  });
});
