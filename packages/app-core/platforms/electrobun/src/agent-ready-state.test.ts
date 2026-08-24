import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentReadyListeners,
  isAgentReady,
  offAgentReadyChange,
  onAgentReadyChange,
  setAgentReady,
} from "./agent-ready-state.js";

describe("agent-ready-state", () => {
  beforeEach(() => {
    setAgentReady(false);
    clearAgentReadyListeners();
  });
  afterEach(() => clearAgentReadyListeners());

  it("tracks ready boolean", () => {
    expect(isAgentReady()).toBe(false);
    setAgentReady(true);
    expect(isAgentReady()).toBe(true);
  });

  it("notifies listeners on set", () => {
    const fn = vi.fn();
    onAgentReadyChange(fn);
    setAgentReady(true);
    expect(fn).toHaveBeenCalledWith(true);
  });

  it("off removes listener", () => {
    const fn = vi.fn();
    onAgentReadyChange(fn);
    offAgentReadyChange(fn);
    setAgentReady(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("clear removes all", () => {
    const a = vi.fn();
    const b = vi.fn();
    onAgentReadyChange(a);
    onAgentReadyChange(b);
    clearAgentReadyListeners();
    setAgentReady(true);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});
