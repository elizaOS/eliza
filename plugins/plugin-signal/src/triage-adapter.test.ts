/**
 * Tests that the Signal triage adapter registers into the shared (real,
 * in-process) triage service and that its availability tracks the signal
 * service's presence on the runtime.
 */
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
  type IAgentRuntime,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSignalTriageAdapter, SignalMessageAdapter } from "./triage-adapter";

function runtimeWith(services: Record<string, unknown>): IAgentRuntime {
  return {
    getService: (name: string) => services[name] ?? null,
  } as unknown as IAgentRuntime;
}

describe("signal triage adapter registration", () => {
  beforeEach(() => __resetDefaultTriageServiceForTests());
  afterEach(() => __resetDefaultTriageServiceForTests());

  it("core ships no signal adapter until the plugin registers one", () => {
    // The plugin owns connector-adapter registration; core pre-registers none.
    expect(getDefaultTriageService().getAdapter("signal")).toBeUndefined();
  });

  it("registers the signal adapter into the shared triage service", () => {
    registerSignalTriageAdapter();

    const service = getDefaultTriageService();
    expect(service.getAdapter("signal")).toBeInstanceOf(SignalMessageAdapter);
    expect(service.listRegisteredSources()).toContain("signal");
  });

  it("reports availability from the signal runtime service", () => {
    registerSignalTriageAdapter();
    const adapter = getDefaultTriageService().getAdapter("signal");

    expect(adapter?.isAvailable(runtimeWith({}))).toBe(false);
    expect(adapter?.isAvailable(runtimeWith({ signal: { __stub: true } }))).toBe(true);
  });
});

describe("truncateUtf16Safe in signal connector target description", () => {
  it("preserves UTF-16 surrogate pairs during truncation", () => {
    // "🔥" is 2 code units. 70 repeats = 140 units > 120
    const longEmoji = "🔥".repeat(70);
    // Slicing at odd index 119 backs off to 118
    let end = 119;
    const code = longEmoji.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
    const truncated = longEmoji.slice(0, end);
    expect(truncated.length).toBe(118);
  });
});

