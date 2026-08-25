/**
 * Exercises boundedGatewayFetch against the real module: timer-safe bound
 * validation, caller abort composition, content-length and streamed byte
 * ceilings, and detached cancellation so a hostile body cannot replace or
 * delay the selected request error. Fetch is injected; globalThis.fetch is
 * never replaced.
 */

import { describe, expect, test } from "bun:test";
import {
  boundedGatewayFetch,
  GatewayProviderFetchError,
} from "./bounded-fetch";

const MAX_TIMER_MS = 2_147_483_647;
const PROVIDER_URL = "https://gateway.example.test/provider";

function asFetch(impl: unknown): typeof fetch {
  return impl as unknown as typeof fetch;
}

const mustNotFetch = asFetch(() => {
  throw new Error("fetch must not be dispatched");
});

function jsonResponse(
  body: string,
  init?: { status?: number; statusText?: string; headers?: HeadersInit },
): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: init?.headers ?? { "content-type": "application/json" },
  });
}

function hungFetch(): typeof fetch {
  return asFetch(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(
              init.signal?.reason ??
                new DOMException("The operation was aborted.", "AbortError"),
            );
          },
          { once: true },
        );
      }),
  );
}

function ignoringHungFetch(): typeof fetch {
  return asFetch(() => new Promise<Response>(() => undefined));
}

function streamResponse(
  chunks: Uint8Array[],
  options?: {
    headers?: HeadersInit;
    status?: number;
    statusText?: string;
    hang?: boolean;
    cancel?: () => Promise<void> | void;
  },
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        if (!options?.hang) {
          controller.close();
        }
      },
      cancel: options?.cancel,
    }),
    {
      status: options?.status ?? 200,
      statusText: options?.statusText ?? "OK",
      headers: options?.headers,
    },
  );
}

describe("GatewayProviderFetchError", () => {
  test("preserves code, message, context, name, and Error prototype", () => {
    const error = new GatewayProviderFetchError(
      "INVALID_GATEWAY_TIMEOUT",
      "Gateway provider bounds must be timer-safe positive integers",
      { timeoutMs: 0, maxResponseBytes: 8 },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GatewayProviderFetchError);
    expect(error.name).toBe("GatewayProviderFetchError");
    expect(error.code).toBe("INVALID_GATEWAY_TIMEOUT");
    expect(error.message).toBe(
      "Gateway provider bounds must be timer-safe positive integers",
    );
    expect(error.context).toEqual({ timeoutMs: 0, maxResponseBytes: 8 });
    expect(Object.getPrototypeOf(error)).toBe(
      GatewayProviderFetchError.prototype,
    );
  });
});

describe("boundedGatewayFetch invalid bounds", () => {
  const cases: Array<{
    name: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }> = [
    { name: "timeoutMs is zero", timeoutMs: 0, maxResponseBytes: 64 },
    { name: "timeoutMs is negative", timeoutMs: -1, maxResponseBytes: 64 },
    { name: "timeoutMs is a float", timeoutMs: 1.5, maxResponseBytes: 64 },
    { name: "timeoutMs is NaN", timeoutMs: Number.NaN, maxResponseBytes: 64 },
    {
      name: "timeoutMs is Infinity",
      timeoutMs: Number.POSITIVE_INFINITY,
      maxResponseBytes: 64,
    },
    {
      name: "timeoutMs exceeds the timer ceiling",
      timeoutMs: MAX_TIMER_MS + 1,
      maxResponseBytes: 64,
    },
    {
      name: "timeoutMs is not a safe integer",
      timeoutMs: Number.MAX_SAFE_INTEGER + 1,
      maxResponseBytes: 64,
    },
    {
      name: "maxResponseBytes is negative",
      timeoutMs: 1_000,
      maxResponseBytes: -1,
    },
    {
      name: "maxResponseBytes is a float",
      timeoutMs: 1_000,
      maxResponseBytes: 1.25,
    },
    {
      name: "maxResponseBytes is NaN",
      timeoutMs: 1_000,
      maxResponseBytes: Number.NaN,
    },
    {
      name: "maxResponseBytes is Infinity",
      timeoutMs: 1_000,
      maxResponseBytes: Number.POSITIVE_INFINITY,
    },
    {
      name: "maxResponseBytes is not a safe integer",
      timeoutMs: 1_000,
      maxResponseBytes: Number.MAX_SAFE_INTEGER + 1,
    },
  ];

  for (const { name, timeoutMs, maxResponseBytes } of cases) {
    test(`${name} rejects before dispatch`, async () => {
      let thrown: unknown;
      try {
        await boundedGatewayFetch(
          mustNotFetch,
          PROVIDER_URL,
          undefined,
          timeoutMs,
          maxResponseBytes,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(GatewayProviderFetchError);
      expect(thrown).toMatchObject({
        name: "GatewayProviderFetchError",
        code: "INVALID_GATEWAY_TIMEOUT",
        message: "Gateway provider bounds must be timer-safe positive integers",
        context: { timeoutMs, maxResponseBytes },
      });
    });
  }

  test("the inclusive timer ceiling is accepted and the timer is cleared", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedSignal = init?.signal ?? undefined;
      return jsonResponse('{"ok":true}');
    }) as unknown as typeof fetch;

    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      MAX_TIMER_MS,
      64,
    );

    expect(await response.json()).toEqual({ ok: true });
    await Bun.sleep(20);
    expect(capturedSignal?.aborted).toBe(false);
  });

  test("maxResponseBytes of zero is a valid empty-body ceiling", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(), {
        status: 204,
      })) as unknown as typeof fetch;
    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      0,
    );
    expect(response.status).toBe(204);
    expect(await response.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });
});

describe("boundedGatewayFetch pre-aborted caller", () => {
  test("throws the caller reason and does not dispatch", async () => {
    const caller = new AbortController();
    const reason = new DOMException("cancelled before dispatch", "AbortError");
    caller.abort(reason);

    let thrown: unknown;
    try {
      await boundedGatewayFetch(
        mustNotFetch,
        PROVIDER_URL,
        { signal: caller.signal },
        1_000,
        64,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(reason);
  });

  test("throws AbortError when the pre-aborted signal has a nullish reason", async () => {
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener() {
        throw new Error("listener must not be registered");
      },
      removeEventListener() {
        throw new Error("listener must not be removed");
      },
    } as unknown as AbortSignal;

    let thrown: unknown;
    try {
      await boundedGatewayFetch(
        mustNotFetch,
        PROVIDER_URL,
        { signal },
        1_000,
        64,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DOMException);
    expect(thrown).toMatchObject({
      name: "AbortError",
      message: "Provider request cancelled",
    });
  });
});

describe("boundedGatewayFetch success", () => {
  test("forwards input and init, replacing only the abort signal", async () => {
    const headers = { "x-test": "1", authorization: "Bearer token" };
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedInput = input;
      capturedInit = init;
      return jsonResponse('{"sid":"SM_ok"}', {
        status: 201,
        statusText: "Created",
      });
    }) as unknown as typeof fetch;

    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      { method: "POST", headers, body: "payload" },
      1_000,
      64,
    );

    expect(capturedInput).toBe(PROVIDER_URL);
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual(headers);
    expect(capturedInit?.body).toBe("payload");
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedInit?.signal?.aborted).toBe(false);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(await response.json()).toEqual({ sid: "SM_ok" });
  });

  test("accepts URL input and undefined init", async () => {
    const target = new globalThis.URL(PROVIDER_URL);
    let capturedInput: RequestInfo | URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedInput = input;
      return jsonResponse("{}");
    }) as unknown as typeof fetch;

    const response = await boundedGatewayFetch(
      fetchImpl,
      target,
      undefined,
      1_000,
      64,
    );
    expect(capturedInput).toBe(target);
    expect(await response.text()).toBe("{}");
  });

  test("returns a null-body response without wrapping it", async () => {
    const original = new Response(null, {
      status: 204,
      statusText: "No Content",
    });
    const fetchImpl = (async () => original) as unknown as typeof fetch;

    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      64,
    );
    expect(response).toBe(original);
    expect(response.body).toBeNull();
  });

  test("reassembles multiple chunks losslessly at the exact byte ceiling", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const fetchImpl = (async () =>
      streamResponse(chunks)) as unknown as typeof fetch;

    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      5,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
  });

  test("zero-length chunks do not consume budget", async () => {
    const chunks = [new Uint8Array(0), new Uint8Array([7]), new Uint8Array(0)];
    const fetchImpl = (async () =>
      streamResponse(chunks)) as unknown as typeof fetch;
    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      1,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([7]),
    );
  });

  test("copies provider headers onto the reconstituted body", async () => {
    const fetchImpl = (async () =>
      jsonResponse('{"ok":true}', {
        headers: { "content-type": "application/json", "x-provider": "twilio" },
      })) as unknown as typeof fetch;
    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      64,
    );
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-provider")).toBe("twilio");
  });

  test("a declared content-length equal to the ceiling is accepted", async () => {
    const body = new Uint8Array([9, 8, 7]);
    const fetchImpl = (async () =>
      streamResponse([body], {
        headers: { "content-length": "3" },
      })) as unknown as typeof fetch;
    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      3,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });
});

describe("boundedGatewayFetch content-length cap", () => {
  const invalidLengths = ["", "12.5", "1e2", "+8", "-1", "0x10"];

  for (const contentLength of invalidLengths) {
    test(`non-digit content-length ${JSON.stringify(contentLength)} is too large`, async () => {
      const fetchImpl = (async () =>
        streamResponse([new Uint8Array([1])], {
          headers: { "content-length": contentLength },
        })) as unknown as typeof fetch;

      await expect(
        boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 64),
      ).rejects.toMatchObject({
        name: "GatewayProviderFetchError",
        code: "GATEWAY_RESPONSE_TOO_LARGE",
        message: "Gateway provider response exceeds the byte limit",
        context: { maxResponseBytes: 64, contentLength },
      });
    });
  }

  test("numeric content-length above the ceiling rejects without reading", async () => {
    const fetchImpl = (async () =>
      streamResponse([new Uint8Array(4)], {
        headers: { "content-length": "4" },
      })) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 3),
    ).rejects.toMatchObject({
      code: "GATEWAY_RESPONSE_TOO_LARGE",
      context: { maxResponseBytes: 3, contentLength: "4" },
    });
  });

  test("Headers-trimmed padded digits still count as a numeric content-length", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const fetchImpl = (async () =>
      streamResponse([body], {
        headers: { "content-length": " 3 " },
      })) as unknown as typeof fetch;
    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      3,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  test("missing content-length defers to the streamed byte count", async () => {
    const fetchImpl = (async () =>
      streamResponse([new Uint8Array([1, 2, 3])])) as unknown as typeof fetch;
    const response = await boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      undefined,
      1_000,
      3,
    );
    expect((await response.arrayBuffer()).byteLength).toBe(3);
  });
});

describe("boundedGatewayFetch streamed byte cap", () => {
  test("a single overflowing chunk is rejected with receivedBytes", async () => {
    const fetchImpl = (async () =>
      streamResponse([new Uint8Array(5)])) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 4),
    ).rejects.toMatchObject({
      name: "GatewayProviderFetchError",
      code: "GATEWAY_RESPONSE_TOO_LARGE",
      context: { maxResponseBytes: 4, receivedBytes: 5 },
    });
  });

  test("overflow across chunks uses the cumulative count", async () => {
    const fetchImpl = (async () =>
      streamResponse([
        new Uint8Array(2),
        new Uint8Array(2),
      ])) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 3),
    ).rejects.toMatchObject({
      code: "GATEWAY_RESPONSE_TOO_LARGE",
      context: { maxResponseBytes: 3, receivedBytes: 4 },
    });
  });

  test("a one-byte body exceeds a zero ceiling", async () => {
    const fetchImpl = (async () =>
      streamResponse([new Uint8Array([1])])) as unknown as typeof fetch;
    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 0),
    ).rejects.toMatchObject({
      code: "GATEWAY_RESPONSE_TOO_LARGE",
      context: { maxResponseBytes: 0, receivedBytes: 1 },
    });
  });
});

describe("boundedGatewayFetch deadline and caller abort", () => {
  test("rejects a hung fetch at the owned deadline even when fetch ignores abort", async () => {
    await expect(
      boundedGatewayFetch(ignoringHungFetch(), PROVIDER_URL, undefined, 15, 64),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Provider request deadline expired",
    });
  });

  test("aborts the composed signal when fetch observes the deadline", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = hungFetch();
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(wrapped, PROVIDER_URL, undefined, 15, 64),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("caller abort wins over a still-running deadline", async () => {
    const caller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const pending = boundedGatewayFetch(
      hungFetch(),
      PROVIDER_URL,
      { signal: caller.signal },
      1_000,
      64,
    );
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test("a live caller signal cannot disable the owned deadline", async () => {
    const caller = new AbortController();
    await expect(
      boundedGatewayFetch(
        ignoringHungFetch(),
        PROVIDER_URL,
        { signal: caller.signal },
        15,
        64,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(caller.signal.aborted).toBe(false);
  });

  test("deadline covers a response body that never completes", async () => {
    const fetchImpl = (async () =>
      streamResponse([new TextEncoder().encode("{")], {
        hang: true,
      })) as unknown as typeof fetch;
    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 15, 64),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("caller abort during a hanging body read uses the caller reason", async () => {
    const caller = new AbortController();
    const reason = new DOMException("stop reading", "AbortError");
    const fetchImpl = (async () =>
      streamResponse([new TextEncoder().encode("{")], {
        hang: true,
      })) as unknown as typeof fetch;
    const pending = boundedGatewayFetch(
      fetchImpl,
      PROVIDER_URL,
      { signal: caller.signal },
      1_000,
      64,
    );
    await Bun.sleep(5);
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test("caller abort() without an argument rejects with AbortError", async () => {
    const caller = new AbortController();
    const pending = boundedGatewayFetch(
      ignoringHungFetch(),
      PROVIDER_URL,
      { signal: caller.signal },
      1_000,
      64,
    );
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("boundedGatewayFetch hostile cancellation", () => {
  test("rejecting body cancellation cannot replace the content-length error", async () => {
    const fetchImpl = (async () =>
      streamResponse([], {
        headers: { "content-length": "65537" },
        cancel() {
          return Promise.reject(new Error("hostile cancel"));
        },
      })) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 64),
    ).rejects.toMatchObject({ code: "GATEWAY_RESPONSE_TOO_LARGE" });
  });

  test("never-settling body cancellation cannot delay the content-length error", async () => {
    const fetchImpl = (async () =>
      streamResponse([], {
        headers: { "content-length": "65537" },
        cancel() {
          return new Promise<void>(() => undefined);
        },
      })) as unknown as typeof fetch;

    const outcome = await Promise.race([
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 64).catch(
        (error: unknown) => error,
      ),
      Bun.sleep(50).then(() => "hung"),
    ]);
    expect(outcome).toMatchObject({ code: "GATEWAY_RESPONSE_TOO_LARGE" });
  });

  test("synchronous body cancellation failure cannot replace the content-length error", async () => {
    const fetchImpl = (async () =>
      ({
        headers: new Headers({ "content-length": "100" }),
        body: {
          cancel() {
            throw new Error("sync cancel boom");
          },
        },
        status: 200,
        statusText: "OK",
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 8),
    ).rejects.toMatchObject({
      code: "GATEWAY_RESPONSE_TOO_LARGE",
      context: { maxResponseBytes: 8, contentLength: "100" },
    });
  });

  test("null body skips cancellation on a content-length error", async () => {
    const fetchImpl = (async () =>
      ({
        headers: new Headers({ "content-length": "100" }),
        body: null,
        status: 200,
        statusText: "OK",
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 8),
    ).rejects.toMatchObject({ code: "GATEWAY_RESPONSE_TOO_LARGE" });
  });

  test("never-settling reader cancellation cannot delay the size error", async () => {
    const fetchImpl = (async () =>
      streamResponse([new Uint8Array(65)], {
        cancel() {
          return new Promise<void>(() => undefined);
        },
      })) as unknown as typeof fetch;

    const outcome = await Promise.race([
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 64).catch(
        (error: unknown) => error,
      ),
      Bun.sleep(50).then(() => "hung"),
    ]);
    expect(outcome).toMatchObject({
      code: "GATEWAY_RESPONSE_TOO_LARGE",
      context: { receivedBytes: 65 },
    });
  });

  test("rejecting reader cancellation cannot replace the size error", async () => {
    const fetchImpl = (async () =>
      streamResponse([new Uint8Array(65)], {
        cancel() {
          return Promise.reject(new Error("hostile reader cancel"));
        },
      })) as unknown as typeof fetch;

    await expect(
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 1_000, 64),
    ).rejects.toMatchObject({ code: "GATEWAY_RESPONSE_TOO_LARGE" });
  });

  test("never-settling reader cancellation cannot delay a body-read timeout", async () => {
    const fetchImpl = (async () =>
      streamResponse([new TextEncoder().encode("{")], {
        hang: true,
        cancel() {
          return new Promise<void>(() => undefined);
        },
      })) as unknown as typeof fetch;

    const outcome = await Promise.race([
      boundedGatewayFetch(fetchImpl, PROVIDER_URL, undefined, 15, 64).catch(
        (error: unknown) => error,
      ),
      Bun.sleep(50).then(() => "hung"),
    ]);
    expect(outcome).toMatchObject({ name: "TimeoutError" });
  });
});
