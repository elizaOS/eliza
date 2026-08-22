/**
 * Proves the synthetic meetings provider is runtime-scoped and fail-closed for
 * missing, unexpected, wrong-platform, and over-consumed adapter calls.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingService } from "./service.js";
import {
  clearMockMeetingScripts,
  disposeMockMeetingProviderState,
  finalizeMockMeetingProviderLedger,
  getMockMeetingProviderLedger,
  mockMeetingDependencies,
  mockMeetingsCompanionPlugin,
  setMockMeetingScript,
} from "./test-support.js";
import type { MeetingBotSession, MeetingPlatform } from "./types.js";

const runtimes: IAgentRuntime[] = [];

function runtime(): IAgentRuntime {
  const value = {} as IAgentRuntime;
  runtimes.push(value);
  return value;
}

function session(nativeMeetingId: string): MeetingBotSession {
  return {
    id: crypto.randomUUID() as UUID,
    config: { nativeMeetingId } as MeetingBotSession["config"],
    sink: {} as MeetingBotSession["sink"],
    signal: new AbortController().signal,
    reportStatus: () => undefined,
  };
}

async function runAdapter(
  runtimeValue: IAgentRuntime,
  platform: MeetingPlatform,
  nativeMeetingId: string,
): Promise<void> {
  const dependencies = mockMeetingDependencies(runtimeValue);
  dependencies.createPipeline({} as never);
  await dependencies.adapters.get(platform)?.run(session(nativeMeetingId));
}

afterEach(() => {
  for (const runtimeValue of runtimes.splice(0)) {
    clearMockMeetingScripts(runtimeValue);
    disposeMockMeetingProviderState(runtimeValue);
  }
  vi.restoreAllMocks();
});

describe("runtime-scoped meetings provider ledger", () => {
  it("installs and disposes the dependency override for its own runtime", async () => {
    const runtimeValue = runtime();
    const install = vi.spyOn(MeetingService, "setRuntimeDependencyFactory");
    const clear = vi.spyOn(MeetingService, "clearRuntimeDependencyFactory");

    await mockMeetingsCompanionPlugin.init?.({}, runtimeValue);
    await mockMeetingsCompanionPlugin.dispose?.(runtimeValue);

    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(runtimeValue, mockMeetingDependencies);
    expect(clear).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(runtimeValue);
  });

  it("does not leak scripts or calls between runtimes", async () => {
    const first = runtime();
    const second = runtime();
    setMockMeetingScript(first, "abc-defg-hij", {
      platform: "google_meet",
      holdUntilLeave: false,
      turns: [],
    });

    await runAdapter(first, "google_meet", "abc-defg-hij");

    expect(getMockMeetingProviderLedger(first).problems).toEqual([]);
    expect(getMockMeetingProviderLedger(second)).toEqual({
      expectations: [],
      calls: [],
      problems: [],
    });
  });

  it("reports an unconsumed exact expectation", () => {
    const runtimeValue = runtime();
    setMockMeetingScript(runtimeValue, "abc-defg-hij", {
      platform: "google_meet",
      holdUntilLeave: false,
      turns: [],
    });

    expect(getMockMeetingProviderLedger(runtimeValue).problems).toEqual([
      "google_meet:abc-defg-hij consumed 0/1",
    ]);
  });

  it("fails finalization for an incomplete ledger and clears it afterward", () => {
    const runtimeValue = runtime();
    setMockMeetingScript(runtimeValue, "abc-defg-hij", {
      platform: "google_meet",
      holdUntilLeave: false,
      turns: [],
    });

    expect(finalizeMockMeetingProviderLedger(runtimeValue)).toMatch(
      /consumed 0\/1/u,
    );
    expect(getMockMeetingProviderLedger(runtimeValue)).toEqual({
      expectations: [],
      calls: [],
      problems: [],
    });
  });

  it("records unexpected and wrong-platform calls as ledger failures", async () => {
    const runtimeValue = runtime();
    setMockMeetingScript(runtimeValue, "abc-defg-hij", {
      platform: "google_meet",
      holdUntilLeave: false,
      turns: [],
    });

    await expect(
      runAdapter(runtimeValue, "zoom", "abc-defg-hij"),
    ).rejects.toThrow(/expected google_meet, received zoom/u);
    await expect(
      runAdapter(runtimeValue, "google_meet", "missing-id"),
    ).rejects.toThrow(/no script registered/u);

    expect(getMockMeetingProviderLedger(runtimeValue).problems).toEqual(
      expect.arrayContaining([
        "google_meet:abc-defg-hij consumed 0/1",
        "meeting abc-defg-hij expected google_meet, received zoom",
        "unexpected google_meet meeting missing-id; no script registered",
      ]),
    );
  });

  it("fails a call beyond exact cardinality", async () => {
    const runtimeValue = runtime();
    setMockMeetingScript(runtimeValue, "abc-defg-hij", {
      platform: "google_meet",
      holdUntilLeave: false,
      turns: [],
      times: 1,
    });

    await runAdapter(runtimeValue, "google_meet", "abc-defg-hij");
    await expect(
      runAdapter(runtimeValue, "google_meet", "abc-defg-hij"),
    ).rejects.toThrow(/over-consumed \(2\/1\)/u);
    expect(getMockMeetingProviderLedger(runtimeValue).problems).toContain(
      "meeting abc-defg-hij over-consumed (2/1)",
    );
  });

  it("finalization catches a provider call made after a clean ledger snapshot", async () => {
    const runtimeValue = runtime();
    setMockMeetingScript(runtimeValue, "abc-defg-hij", {
      platform: "google_meet",
      holdUntilLeave: false,
      turns: [],
    });
    await runAdapter(runtimeValue, "google_meet", "abc-defg-hij");
    expect(getMockMeetingProviderLedger(runtimeValue).problems).toEqual([]);

    await expect(
      runAdapter(runtimeValue, "google_meet", "abc-defg-hij"),
    ).rejects.toThrow(/over-consumed/u);

    expect(finalizeMockMeetingProviderLedger(runtimeValue)).toMatch(
      /over-consumed/u,
    );
  });
});
