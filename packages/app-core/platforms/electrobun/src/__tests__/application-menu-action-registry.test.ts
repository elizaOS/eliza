import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeApplicationMenuAction,
  setApplicationMenuActionHandler,
} from "./application-menu-action-registry.ts";

describe("application-menu-action-registry", () => {
  beforeEach(() => setApplicationMenuActionHandler(null));
  afterEach(() => setApplicationMenuActionHandler(null));

  it("returns false when no handler is registered", async () => {
    expect(await invokeApplicationMenuAction("open")).toBe(false);
  });

  it("invokes the registered handler and returns true", async () => {
    const handler = vi.fn(async () => undefined);
    setApplicationMenuActionHandler(handler);
    expect(await invokeApplicationMenuAction("open")).toBe(true);
    expect(handler).toHaveBeenCalledWith("open");
  });

  it("passes undefined action through", async () => {
    const handler = vi.fn(async () => undefined);
    setApplicationMenuActionHandler(handler);
    await invokeApplicationMenuAction(undefined);
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it("clearing the handler stops invocation", async () => {
    const handler = vi.fn(async () => undefined);
    setApplicationMenuActionHandler(handler);
    setApplicationMenuActionHandler(null);
    expect(await invokeApplicationMenuAction("open")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("replacing the handler uses the newest one", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    setApplicationMenuActionHandler(first);
    setApplicationMenuActionHandler(second);
    await invokeApplicationMenuAction("x");
    expect(second).toHaveBeenCalledWith("x");
    expect(first).not.toHaveBeenCalled();
  });
});
