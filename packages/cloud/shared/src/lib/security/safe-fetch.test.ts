import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const lookupMock = vi.fn();
const requestMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));
vi.mock("node:http", () => ({
  request: requestMock,
}));
vi.mock("node:https", () => ({
  request: requestMock,
}));

const { createPinnedLookup, safeFetch } = await import("./safe-fetch");
const { resolveSafeOutboundTarget } = await import("./outbound-url");

type FakeIncomingMessage = IncomingMessage & {
  destroy: ReturnType<typeof vi.fn>;
};

type FakeClientRequest = ClientRequest & {
  chunks: Buffer[];
  emitError: (error: Error) => void;
};

function createFakeIncomingMessage(
  overrides: Partial<Pick<IncomingMessage, "headers" | "statusCode" | "statusMessage">> = {},
): FakeIncomingMessage {
  return Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    headers: overrides.headers ?? {},
    statusCode: overrides.statusCode ?? 200,
    statusMessage: overrides.statusMessage ?? "OK",
  }) as FakeIncomingMessage;
}

function createFakeClientRequest(onEnd?: (req: FakeClientRequest) => void): FakeClientRequest {
  const req = Object.assign(new EventEmitter(), {
    chunks: [] as Buffer[],
    destroy: vi.fn((error?: Error) => {
      if (error) {
        queueMicrotask(() => req.emit("error", error));
      }
      return req;
    }),
    emitError: (error: Error) => {
      req.emit("error", error);
    },
    end: vi.fn((chunk?: string | Uint8Array) => {
      if (chunk !== undefined) {
        req.chunks.push(Buffer.from(chunk));
      }
      onEnd?.(req);
      return req;
    }),
    write: vi.fn((chunk: string | Uint8Array) => {
      req.chunks.push(Buffer.from(chunk));
      return true;
    }),
  }) as FakeClientRequest;
  return req;
}

function utf8Stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// `vi.mock("node:dns/promises")` is process-global, so leave the stub returning
// a benign public IP for any suite that loads afterwards (see outbound-url.test).
afterAll(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("createPinnedLookup", () => {
  test("returns the pinned address for the legacy (address, family) callback", () => {
    const cb = vi.fn();
    createPinnedLookup("93.184.216.34", 4)("example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  test("returns the pinned address as an array when `all` is requested", () => {
    const cb = vi.fn();
    createPinnedLookup("93.184.216.34", 4)("example.com", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  test.each([
    "169.254.169.254",
    "127.0.0.1",
    "10.0.0.5",
    "::1",
  ])("rejects a pin that re-checks as a private/reserved address (%s)", (address) => {
    const cb = vi.fn();
    createPinnedLookup(address, address.includes(":") ? 6 : 4)("host", { all: true }, cb);
    const [error] = cb.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/private or reserved/i);
  });
});

describe("resolveSafeOutboundTarget (connection pin)", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  test("pins to the first validated resolved address", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);

    const { url, address, family } = await resolveSafeOutboundTarget("https://example.com/path");
    expect(url.hostname).toBe("example.com");
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });

  test("pins an IP-literal target without a DNS round-trip", async () => {
    const { address, family } = await resolveSafeOutboundTarget("https://93.184.216.34/x");
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test("rejects when a host resolves to any private/reserved address", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(resolveSafeOutboundTarget("https://example.com/")).rejects.toThrow(
      "Endpoint resolves to a private or reserved IP address",
    );
  });

  // A redirect hop re-runs exactly this resolver, so a rebinding redirect host
  // is rejected before safeFetch can re-pin and re-issue the request.
  test("rejects a rebinding redirect host that now resolves to link-local metadata", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    await expect(resolveSafeOutboundTarget("https://rebind.example/")).rejects.toThrow(
      "Endpoint resolves to a private or reserved IP address",
    );
  });
});

describe("safeFetch fail-closed", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    requestMock.mockReset();
  });

  test("never connects when the target host resolves to a private address", async () => {
    // 127.0.0.1 has a live local listener (the test runner) — the unpinned
    // `assertSafeOutboundUrl(url) + fetch(url)` pattern would happily connect to
    // it on the second resolution. safeFetch rejects during validation, so no
    // socket is opened.
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(safeFetch("https://rebind.example/internal")).rejects.toThrow(
      "Endpoint resolves to a private or reserved IP address",
    );
  });

  test("rejects credential-bearing and non-http targets before any lookup", async () => {
    await expect(safeFetch("http://user:pass@example.com/")).rejects.toThrow();
    await expect(safeFetch("ftp://example.com/file")).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test("streams response bodies from pinned Node requests", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    requestMock.mockImplementation((_options, onResponse) => {
      const req = createFakeClientRequest(() => {
        const res = createFakeIncomingMessage();
        onResponse(res);
        queueMicrotask(() => {
          res.emit("data", "hello");
          res.emit("data", Buffer.from(" world"));
          res.emit("end");
        });
      });
      return req;
    });

    const response = await safeFetch("http://example.com/stream");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("hello world");
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  test("writes ReadableStream request bodies to pinned Node requests", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    requestMock.mockImplementation((_options, onResponse) =>
      createFakeClientRequest((req) => {
        const res = createFakeIncomingMessage();
        onResponse(res);
        queueMicrotask(() => {
          res.emit("data", Buffer.concat(req.chunks));
          res.emit("end");
        });
      }),
    );

    const response = await safeFetch("http://example.com/upload", {
      method: "POST",
      body: utf8Stream("chunk-", "body"),
    });

    await expect(response.text()).resolves.toBe("chunk-body");
  });

  test("cancels pinned response streams by destroying the Node response", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    let responseMessage: FakeIncomingMessage | null = null;
    requestMock.mockImplementation((_options, onResponse) => {
      const req = createFakeClientRequest(() => {
        responseMessage = createFakeIncomingMessage();
        onResponse(responseMessage);
      });
      return req;
    });

    const response = await safeFetch("http://example.com/cancel");
    await response.body?.cancel();

    expect(responseMessage?.destroy).toHaveBeenCalledTimes(1);
  });

  test("rejects when a ReadableStream request body errors", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    requestMock.mockImplementation(() => createFakeClientRequest());
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body exploded");
      },
    });

    await expect(safeFetch("http://example.com/upload", { method: "POST", body })).rejects.toThrow(
      "body exploded",
    );
  });

  test("rejects when a ReadableStream request body is already locked", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    requestMock.mockImplementation(() => createFakeClientRequest());
    const body = utf8Stream("locked body");
    const reader = body.getReader();

    try {
      await expect(
        safeFetch("http://example.com/upload", { method: "POST", body }),
      ).rejects.toThrow(/locked|reader/i);
    } finally {
      reader.releaseLock();
    }
  });
});
