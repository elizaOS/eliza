import { describe, expect, it, vi } from "vitest";
import type { DynamicViewRegistry } from "../dynamic-views/registry";
import type { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { getTraceService, resetTraceStateForTests } from "./index.js";

describe("trace index", () => {
  it("getTraceService returns same singleton for same registry", () => {
    resetTraceStateForTests();
    const register = vi.fn();
    const registry = { register } as unknown as DynamicViewRegistry;
    const sessions = {} as DynamicViewSessionManager;
    const svc1 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });
    const svc2 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });
    expect(svc1).toBe(svc2);
    expect(register).toHaveBeenCalled();
  });

  it("reset clears singleton", () => {
    resetTraceStateForTests();
    const registry = { register: vi.fn() } as unknown as DynamicViewRegistry;
    const sessions = {} as DynamicViewSessionManager;
    const svc1 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });
    resetTraceStateForTests();
    const svc2 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });
    expect(svc1).not.toBe(svc2);
  });
});
