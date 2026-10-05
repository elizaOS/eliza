// @vitest-environment node
import { expect, it, vi } from "vitest";
import { readExecutionStream } from "./execute-stream";

it.each([
  ["", "without a completion"],
  ['data: {"done":true}', "Truncated"],
  ['data: {"done":true,"error":"failed"}\n\n', "Contradictory"],
  ['data: {"done":true}\n\ndata: {"done":true}\n\n', "after completion"],
  [
    'data: {"status":"failed","detail":"write failed"}\n\ndata: {"done":true}\n\n',
    "write failed",
  ],
])(
  "rejects incomplete or contradictory execution: %s",
  async (body, message) => {
    await expect(
      readExecutionStream(new Response(body), vi.fn()),
    ).rejects.toThrow(message);
  },
);
it.each(["", "first failure"])(
  "retains a failed result with detail %j",
  async (detail) => {
    const events = [
      { status: "failed", detail },
      { status: "failed", detail: "" },
      { done: true },
    ];
    const body = events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    await expect(
      readExecutionStream(new Response(body), vi.fn()),
    ).rejects.toThrow(detail);
  },
);
it("accepts split UTF-8 and CRLF only after the sole success terminal", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"detail":"😀"}\r\n\r\ndata: {"done":true}\r\n\r\n',
  );
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const progress = vi.fn();
  await readExecutionStream(new Response(stream), progress);
  expect(progress).toHaveBeenCalledExactlyOnceWith({ detail: "😀" });
});
