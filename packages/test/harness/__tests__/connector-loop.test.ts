/**
 * Keyless connector loop e2e: inbound message → mock LLM → outbound reply.
 *
 * A connector's job is to turn an inbound platform event into a runtime message
 * and deliver the agent's reply back out. This drives that loop generically: an
 * inbound `Memory` goes through `runtime.messageService.handleMessage` (the same
 * entrypoint every `MessageConnector` uses), the deterministic mock LLM produces
 * the turn, and the outbound `callback` (the connector's send seam) captures the
 * reply — no provider key, no network. Per-connector e2es (telegram via its
 * `TELEGRAM_API_ROOT` Mockoon seam, etc.) follow this shape.
 */
import {
  ChannelType,
  createMessageMemory,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { type MockLlmRuntime, withMockLlmRuntime } from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

describe("connector loop (keyless)", () => {
  it("routes an inbound message through the mock LLM to an outbound reply", async () => {
    // Heuristic (non-strict) proxy: the runtime's reply turn makes several model
    // calls; let the proxy answer them deterministically without hand fixtures.
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const worldId = stringToUuid("connector-loop-world") as UUID;
    const roomId = stringToUuid("connector-loop-room") as UUID;
    const userId = stringToUuid("connector-loop-user") as UUID;

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "Tester",
      source: "test-connector",
      channelId: roomId,
      type: ChannelType.DM,
    });

    const inbound: Memory = createMessageMemory({
      id: stringToUuid("connector-loop-msg-1") as UUID,
      entityId: userId,
      roomId,
      content: {
        text: "Hello there, please reply.",
        source: "test-connector",
        channelType: ChannelType.DM,
      },
    });

    let outbound = "";
    const callback = async (content: { text?: string }): Promise<unknown[]> => {
      if (content.text) outbound += content.text;
      return [];
    };

    const service = (
      runtime as unknown as {
        messageService?: {
          handleMessage: (
            rt: typeof runtime,
            memory: Memory,
            cb: typeof callback,
            options?: Record<string, unknown>,
          ) => Promise<{ responseContent?: { text?: string } }>;
        };
      }
    ).messageService;
    expect(service, "runtime.messageService is initialized").toBeDefined();

    const result = await service?.handleMessage(runtime, inbound, callback, {});
    if (!outbound && result?.responseContent?.text) {
      outbound = result.responseContent.text;
    }

    // The loop closed: the inbound message produced a non-empty outbound reply
    // entirely through the deterministic mock LLM.
    expect(outbound.trim().length).toBeGreaterThan(0);
  });
});
