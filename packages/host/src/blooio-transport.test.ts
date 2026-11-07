import { afterEach, expect, it, vi } from "vitest";
import { sendBlooioMessage } from "./blooio-transport";

const input = {
  apiKey: "synthetic-key",
  from: "+15555550100",
  to: "+15555550101",
  text: "synthetic-code",
  idempotencyKey: "stable-attempt",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("retains direct and group delivery wire shapes and requires a provider receipt", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ message_id: "provider-id" }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await sendBlooioMessage(input)).toEqual({
    success: true,
    messageId: "provider-id",
    chatId: input.to,
  });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.blooio.com/v4/messages");
  const init = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual({
    to: input.to,
    from: input.from,
    text: input.text,
  });
  expect(init.redirect).toBe("manual");
  expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
    input.idempotencyKey,
  );
  await sendBlooioMessage({ ...input, to: "chat_id:group/id" });
  expect(fetch.mock.calls[1]?.[0]).toBe(
    "https://api.blooio.com/v4/chats/group%2Fid/messages",
  );
  expect(
    JSON.parse(
      String((fetch.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ),
  ).toEqual({ text: input.text });
});
it("rejects redirects and transport errors without echoing delivery secrets", async () => {
  const secret = `${input.apiKey} ${input.text} ${input.to}`;
  for (const response of [
    () =>
      new Response(secret, {
        status: 302,
        headers: { location: "https://other.invalid" },
      }),
    () => new Response(secret, { status: 401 }),
    () => {
      throw new Error(secret);
    },
  ]) {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const result = await sendBlooioMessage(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(input.apiKey);
    expect(JSON.stringify(result)).not.toContain(input.text);
    expect(JSON.stringify(result)).not.toContain(input.to);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});
it("refuses malformed, oversized and missing acceptance receipts", async () => {
  for (const body of [
    "not-json",
    "{}",
    JSON.stringify({ id: "" }),
    JSON.stringify({ id: "provider-id", success: false }),
    JSON.stringify({ id: "provider-id", content: "x".repeat(16_384) }),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    expect((await sendBlooioMessage(input)).success).toBe(false);
  }
});

function privateFailure(result: Awaited<ReturnType<typeof sendBlooioMessage>>) {
  expect(result).toEqual({ success: false, error: "Blooio delivery failed" });
  for (const secret of [input.text, input.to, input.from, input.apiKey])
    expect(JSON.stringify(result)).not.toContain(secret);
}
it("hung receipt body respects the controlled whole-request deadline", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  let bodyEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    bodyEntered = resolve;
  });
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull() {
      if (stream.locked) bodyEntered?.();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(stream)),
  );
  const result = sendBlooioMessage(input);
  await entered;
  deadline.abort(new Error(`${input.text} ${input.to} ${input.apiKey}`));
  privateFailure(await result);
  expect(timeout).toHaveBeenCalledWith(30000);
});
it("a never-resolving stream cancellation cannot block rejecting oversized evidence", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new Uint8Array(16385));
    },
    cancel,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(stream)),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      sendBlooioMessage(input),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Receipt rejection blocked on cancellation")),
          100,
        );
      }),
    ]);
    privateFailure(result);
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(timer);
  }
});
it("receipt limit counts cumulative chunks even when each chunk is within the limit", async () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      id: "valid-provider-id",
      note: `${input.text} ${input.to} ${input.apiKey} ${"x".repeat(20000)}`,
    }),
  );
  const chunks = [
    encoded.subarray(0, 8000),
    encoded.subarray(8000, 16000),
    encoded.subarray(16000),
  ];
  expect(chunks.every((chunk) => chunk.byteLength <= 16384)).toBe(true);
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(stream)),
  );
  privateFailure(await sendBlooioMessage(input));
});
it("invalid UTF-8 cannot be repaired into an accepted JSON receipt", async () => {
  const prefix = new TextEncoder().encode(
    `{"id":"valid-provider-id","note":"${input.text} ${input.to} ${input.apiKey} `,
  );
  const suffix = new TextEncoder().encode('"}');
  const bytes = new Uint8Array([...prefix, 0xc3, 0x28, ...suffix]);
  expect(JSON.parse(new TextDecoder().decode(bytes)).id).toBe(
    "valid-provider-id",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bytes)),
  );
  privateFailure(await sendBlooioMessage(input));
});
