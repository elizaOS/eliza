/**
 * Deterministic cancellation tests for the OpenAI research handler. A mocked
 * fetch waits on the real request signal so caller aborts and provider
 * deadlines exercise the transport boundary without spending API quota.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleResearch } from "../models/research";

function createRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    character: { name: "Research test" },
    getSetting(key: string) {
      const values: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_RESEARCH_TIMEOUT: "10000",
        ...settings,
      };
      return values[key];
    },
  } as unknown as IAgentRuntime;
}

function abortableFetch(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("Research request did not include an abort signal"));
        return;
      }

      const rejectWithReason = () => reject(signal.reason);
      if (signal.aborted) {
        rejectWithReason();
        return;
      }
      signal.addEventListener("abort", rejectWithReason, { once: true });
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAI research cancellation", () => {
  it("aborts the in-flight provider request when the caller cancels", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(abortableFetch());
    const controller = new AbortController();

    const request = handleResearch(createRuntime(), {
      input: "Research cancellation behavior.",
      signal: controller.signal,
    });
    controller.abort(new DOMException("Research cancelled", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retains the configured provider timeout when no caller signal fires", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(abortableFetch());

    await expect(
      handleResearch(createRuntime({ OPENAI_RESEARCH_TIMEOUT: "5" }), {
        input: "Research timeout behavior.",
      })
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
