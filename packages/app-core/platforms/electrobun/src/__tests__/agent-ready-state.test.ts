import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentReadyListeners,
  isAgentReady,
  offAgentReadyChange,
  onAgentReadyChange,
  setAgentReady,
} from "../agent-ready-state.ts";

describe("agent-ready-state", () => {
  beforeEach(() => {
    setAgentReady(false);
    clearAgentReadyListeners();
  });
  afterEach(() => clearAgentReadyListeners());

  it("starts not ready", () => {
    expect(isAgentReady()).toBe(false);
  });

  it("tracks ready state", () => {
    setAgentReady(true);
    expect(isAgentReady()).toBe(true);
    setAgentReady(false);
    expect(isAgentReady()).toBe(false);
  });

  it("notifies listeners on change", () => {
    const listener = vi.fn();
    onAgentReadyChange(listener);
    setAgentReady(true);
    expect(listener).toHaveBeenCalledWith(true);
    setAgentReady(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("does not notify after unsubscribe", () => {
    const listener = vi.fn();
    onAgentReadyChange(listener);
    offAgentReadyChange(listener);
    setAgentReady(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("clearAgentReadyListeners removes all listeners", () => {
    const a = vi.fn();
    const b = vi.fn();
    onAgentReadyChange(a);
    onAgentReadyChange(b);
    clearAgentReadyListeners();
    setAgentReady(true);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("setAgentReady(true) then false notifies in order", () => {
    const calls: boolean[] = [];
    onAgentReadyChange((v) => calls.push(v));
    setAgentReady(true);
    setAgentReady(false);
    expect(calls).toEqual([true, false]);
  });
});
