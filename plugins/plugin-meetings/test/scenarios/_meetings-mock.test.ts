/** Proves meeting scenario cleanup always finalizes its exact provider ledger after service quiescence failures. */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  getMockMeetingProviderLedger,
  setMockMeetingScript,
} from "../../src/test-support.js";
import { finalizeMeetingMockLedger } from "./_meetings-mock.js";

const sessionId = "00000000-0000-0000-0000-000000000123" as UUID;

function runtimeWithService(service: object | null): IAgentRuntime {
  return {
    getService: (name: string) => (name === "meetings" ? service : null),
  } as unknown as IAgentRuntime;
}

async function applyFinalizer(
  runtime: IAgentRuntime,
): Promise<string | undefined> {
  const cleanup = finalizeMeetingMockLedger();
  const result = await cleanup.apply({ runtime } as ScenarioContext);
  return result === undefined ? undefined : result;
}

function installUnconsumedExpectation(runtime: IAgentRuntime): void {
  setMockMeetingScript(runtime, "abc-defg-hij", {
    platform: "google_meet",
    holdUntilLeave: false,
    turns: [],
  });
}

describe("meeting scenario finalization", () => {
  it("combines a missing service with the ledger failure and still clears the ledger", async () => {
    const runtime = runtimeWithService(null);
    installUnconsumedExpectation(runtime);

    await expect(applyFinalizer(runtime)).resolves.toMatch(
      /service missing.*consumed 0\/1/u,
    );
    expect(getMockMeetingProviderLedger(runtime)).toEqual({
      expectations: [],
      calls: [],
      problems: [],
    });
  });

  it("combines a wait failure with the ledger failure and still clears the ledger", async () => {
    const runtime = runtimeWithService({
      listSessions: () => [{ id: sessionId }],
      stopSession: () => true,
      waitForSessionCompletion: async () => {
        throw new Error("wait exploded");
      },
      pendingSessionWorkCount: () => 0,
    });
    installUnconsumedExpectation(runtime);

    await expect(applyFinalizer(runtime)).resolves.toMatch(
      /failed to quiesce: wait exploded.*consumed 0\/1/u,
    );
    expect(getMockMeetingProviderLedger(runtime)).toEqual({
      expectations: [],
      calls: [],
      problems: [],
    });
  });

  it("combines pending session work with the ledger failure and still clears the ledger", async () => {
    const runtime = runtimeWithService({
      listSessions: () => [],
      stopSession: () => true,
      waitForSessionCompletion: async () => undefined,
      pendingSessionWorkCount: () => 2,
    });
    installUnconsumedExpectation(runtime);

    await expect(applyFinalizer(runtime)).resolves.toMatch(
      /retained 2 pending session.*consumed 0\/1/u,
    );
    expect(getMockMeetingProviderLedger(runtime)).toEqual({
      expectations: [],
      calls: [],
      problems: [],
    });
  });
});
