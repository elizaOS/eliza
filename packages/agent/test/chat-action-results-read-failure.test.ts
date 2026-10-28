/**
 * Proves an unreadable action-result store cannot masquerade as "no action
 * succeeded". The chat route uses this read to decide which parsed fallback
 * actions were executed; an empty array on read failure makes every parsed
 * action look unexecuted and replaces the reply with a false
 * "actions were not executed" failure.
 */
import type { AgentRuntime, UUID } from "@elizaos/core";
import { expect, it } from "vitest";
import { readRuntimeActionResults } from "../src/api/chat-routes.ts";

it("rejects an unreadable action-result store instead of reporting no results", () => {
  const messageId = "00000000-0000-0000-0000-0000000000ab" as UUID;
  const stored = [{ actionName: "SEND_EMAIL", success: true }];
  const healthy = {
    getActionResults: (id: UUID) => (id === messageId ? stored : []),
  } as unknown as AgentRuntime;
  expect(readRuntimeActionResults(healthy, messageId)).toEqual(stored);
  // Legitimate "none": no message id, or a runtime that exposes no reader.
  expect(readRuntimeActionResults(healthy, undefined)).toEqual([]);
  expect(readRuntimeActionResults({} as AgentRuntime, messageId)).toEqual([]);

  const unreadable = {
    getActionResults: (): unknown[] => {
      throw new Error("state cache unavailable");
    },
  } as unknown as AgentRuntime;
  let observed: unknown;
  try {
    observed = {
      resolvedWith: readRuntimeActionResults(unreadable, messageId),
    };
  } catch (error) {
    observed = error;
  }
  expect(observed).toMatchObject({
    code: "ACTION_RESULTS_READ_FAILED",
    cause: expect.any(Error),
    context: { messageId },
  });
});

it("calls a receiver-dependent getActionResults with the runtime bound", () => {
  const messageId = "00000000-0000-0000-0000-0000000000cd" as UUID;
  const stored = [{ actionName: "REPLY", success: true }];
  // Mirrors AgentRuntime.getActionResults, a class method reading `this.stateCache`.
  class StateCacheRuntime {
    stateCache = new Map<string, { data: { actionResults: unknown[] } }>([
      [`${messageId}_action_results`, { data: { actionResults: stored } }],
    ]);
    getActionResults(id: UUID): unknown[] {
      return (
        this.stateCache.get(`${id}_action_results`)?.data.actionResults ?? []
      );
    }
  }
  const runtime = new StateCacheRuntime() as unknown as AgentRuntime;
  expect(readRuntimeActionResults(runtime, messageId)).toEqual(stored);
});
