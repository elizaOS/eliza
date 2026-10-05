import type { JsonValue, Memory, UUID } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { createMockRuntime } from "../../src/mock-runtime.ts";
import { attachInterceptor } from "./interceptor.ts";

it("records only completed writes and snapshots their submitted content", async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error("write rejected"))
    .mockResolvedValue("00000000-0000-0000-0000-000000000001");
  const runtime = createMockRuntime({ createMemory: write });
  const interceptor = attachInterceptor(runtime);
  const memory = {
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text: "original" },
  } as Memory;
  await expect(runtime.createMemory(memory, "messages")).rejects.toThrow(
    "write rejected",
  );
  expect(interceptor.memoryWrites).toEqual([]);
  await runtime.createMemory(memory, "messages");
  memory.content.text = "changed";
  expect(interceptor.memoryWrites).toMatchObject([
    { content: { text: "original" } },
  ]);
  interceptor.detach();
  expect(runtime.createMemory).toBe(write);
});

it.each([undefined, false, true])(
  "preserves the actual non-object action outcome %s",
  async (outcome) => {
    const runtime = createMockRuntime({
      actions: [
        {
          name: "OUTCOME",
          description: "fixture",
          similes: [],
          examples: [],
          validate: async () => true,
          handler: vi.fn().mockResolvedValue(outcome),
        },
      ],
    });
    const interceptor = attachInterceptor(runtime);
    await runtime.actions[0].handler(runtime, {
      entityId: runtime.agentId,
      roomId: runtime.agentId as UUID,
      content: {},
    });
    expect(interceptor.actions[0].result).toEqual(
      outcome === undefined ? {} : { success: outcome },
    );
    interceptor.detach();
  },
);

it("rejects unsupported capture depth before running an action instead of truncating evidence", async () => {
  const handler = vi.fn().mockResolvedValue({ success: true });
  const runtime = createMockRuntime({
    actions: [
      {
        name: "DEEP",
        description: "fixture",
        similes: [],
        examples: [],
        validate: async () => true,
        handler,
      },
    ],
  });
  const capture = attachInterceptor(runtime);
  let options: Record<string, JsonValue> = { sentinel: "complete" };
  for (let index = 0; index < 130; index++) options = { child: options };
  try {
    await expect(
      runtime.actions[0].handler(
        runtime,
        {
          entityId: runtime.agentId,
          roomId: runtime.agentId as UUID,
          content: {},
        },
        undefined,
        options,
      ),
    ).rejects.toThrow("refusing to truncate");
    expect(handler).not.toHaveBeenCalled();
    expect(capture.actions).toEqual([]);
  } finally {
    capture.detach();
  }
});
