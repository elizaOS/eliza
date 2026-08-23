import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getActiveLocalAgentDispatcher,
  requireActiveLocalAgentDispatcher,
  setActiveLocalAgentDispatcher,
} from "../local-agent-dispatcher-registry.ts";

describe("local-agent-dispatcher-registry", () => {
  beforeEach(() => setActiveLocalAgentDispatcher(null));
  afterEach(() => setActiveLocalAgentDispatcher(null));

  it("starts with no dispatcher", () => {
    expect(getActiveLocalAgentDispatcher()).toBeNull();
  });

  it("returns the registered dispatcher", () => {
    const dispatcher = { name: "ipc" } as never;
    setActiveLocalAgentDispatcher(dispatcher);
    expect(getActiveLocalAgentDispatcher()).toBe(dispatcher);
  });

  it("requireActiveLocalAgentDispatcher returns the dispatcher when set", () => {
    const dispatcher = {} as never;
    setActiveLocalAgentDispatcher(dispatcher);
    expect(requireActiveLocalAgentDispatcher()).toBe(dispatcher);
  });

  it("requireActiveLocalAgentDispatcher throws when unset", () => {
    expect(() => requireActiveLocalAgentDispatcher()).toThrow(
      "no local-agent IPC dispatcher",
    );
  });

  it("clearing with null resets the registry", () => {
    setActiveLocalAgentDispatcher({} as never);
    setActiveLocalAgentDispatcher(null);
    expect(getActiveLocalAgentDispatcher()).toBeNull();
  });
});
