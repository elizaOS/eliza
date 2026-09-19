/** Exercises WEB_FETCH through the real SSRF-guard timeout with controlled DNS and a stalled transport. */

import type { Memory } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { afterEach, expect, it } from "vitest";
import {
  __resetWebHttpTestOverrides,
  __setWebHttpLookupFnForTests,
  __setWebHttpPinnedFetchImplForTests,
} from "../lib/web-http.js";
import { webFetchAction } from "./web-fetch.js";

afterEach(() => __resetWebHttpTestOverrides());

it("names the alternative read tool after the guard's actual deadline aborts the request", async () => {
  let dispatched = 0;
  let timeoutSignal: AbortSignal | undefined;
  __setWebHttpLookupFnForTests(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  __setWebHttpPinnedFetchImplForTests(async ({ init }) => {
    dispatched += 1;
    const signal = init.signal;
    if (!signal) throw new Error("Guard did not provide its deadline signal");
    timeoutSignal = signal;
    signal.throwIfAborted();
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const runtime = createMockRuntime();
  const message: Memory = {
    entityId: "00000000-0000-4000-8000-000000000001",
    roomId: "00000000-0000-4000-8000-000000000002",
    content: { text: "Read the public endpoint." },
  };
  const result = await webFetchAction.handler(runtime, message, undefined, {
    parameters: { url: "https://public.example.test/stalled" },
  });
  expect(dispatched).toBe(1);
  expect(timeoutSignal?.aborted).toBe(true);
  expect(timeoutSignal?.reason).toMatchObject({ name: "AbortError" });
  expect(result).toMatchObject({ success: false });
  expect(result?.text).toMatch(/aborted/iu);
  expect(result?.text).toContain("WEB_SEARCH");
}, 25_000);
