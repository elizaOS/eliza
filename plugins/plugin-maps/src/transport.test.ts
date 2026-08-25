import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapsError } from "./errors";
import {
  cancelBody,
  observeTeardown,
  readBoundedBody,
  requestDeadline,
  retryAfterMs,
} from "./transport";

function jsonResponse(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, { headers, status });
}

const encoder = new TextEncoder();

describe("retryAfterMs", () => {
  it("returns undefined when the header is absent", () => {
    expect(retryAfterMs(jsonResponse(null))).toBeUndefined();
  });

  it("converts delay-seconds to milliseconds", () => {
    expect(retryAfterMs(jsonResponse(null, { "retry-after": "120" }))).toBe(
      120_000,
    );
    expect(retryAfterMs(jsonResponse(null, { "retry-after": "0" }))).toBe(0);
    expect(retryAfterMs(jsonResponse(null, { "retry-after": "120.5" }))).toBe(
      120_500,
    );
  });

  it("converts HTTP-date retry-after to an absolute timestamp", () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    const ms = retryAfterMs(jsonResponse(null, { "retry-after": date }));
    expect(ms).toBeGreaterThan(0);
  });

  it("returns undefined for unparseable values", () => {
    expect(
      retryAfterMs(jsonResponse(null, { "retry-after": "garbage" })),
    ).toBeUndefined();
  });
});

describe("requestDeadline", () => {
  it("aborts with a TimeoutError once the deadline elapses", async () => {
    vi.useFakeTimers();
    try {
      const deadline = requestDeadline(100);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(101);
      expect(deadline.signal.aborted).toBe(true);
      expect((deadline.signal.reason as DOMException).name).toBe(
        "TimeoutError",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose cancels the pending timeout", async () => {
    vi.useFakeTimers();
    try {
      const deadline = requestDeadline(100);
      deadline.dispose();
      vi.advanceTimersByTime(10_000);
      expect(deadline.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cancelBody / observeTeardown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels the underlying stream with the given reason", () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = { body: { cancel } } as unknown as Response;
    cancelBody(response, "maps declared response exceeded byte limit");
    expect(cancel).toHaveBeenCalledWith(
      "maps declared response exceeded byte limit",
    );
  });

  it("observes teardown failures without surfacing them", async () => {
    const spy = vi.spyOn(logger, "debug").mockImplementation(() => {});
    observeTeardown(
      Promise.reject(new Error("teardown boom")),
      "response-deadline",
    );
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const payload = spy.mock.calls[0][0] as {
      errorName: string;
      surface: string;
    };
    expect(payload.errorName).toBe("Error");
    expect(payload.surface).toBe("response-deadline");
  });
});

describe("readBoundedBody", () => {
  it("reads a small body within the byte limit", async () => {
    const response = jsonResponse(encoder.encode("hello maps"));
    const deadline = requestDeadline(1_000);
    try {
      const body = await readBoundedBody(response, deadline, 10_000);
      expect(body).toBe("hello maps");
    } finally {
      deadline.dispose();
    }
  });

  it("returns an empty string for a bodyless response", async () => {
    const response = jsonResponse(null);
    const deadline = requestDeadline(1_000);
    try {
      await expect(readBoundedBody(response, deadline, 100)).resolves.toBe("");
    } finally {
      deadline.dispose();
    }
  });

  it("rejects a declared content-length above the byte limit and cancels the body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      headers: new Headers({ "content-length": "5000" }),
      status: 200,
      body: { cancel },
    } as unknown as Response;
    const deadline = requestDeadline(1_000);
    try {
      await expect(
        readBoundedBody(response, deadline, 100),
      ).rejects.toMatchObject({
        name: "MapsError",
        code: "MAPS_RESPONSE_TOO_LARGE",
      });
      expect(cancel).toHaveBeenCalledWith(
        "maps declared response exceeded byte limit",
      );
    } finally {
      deadline.dispose();
    }
  });

  it("rejects a streamed overrun above the byte limit", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("0123456789"));
        controller.enqueue(encoder.encode("abcdefghij"));
        controller.close();
      },
    });
    const response = jsonResponse(stream);
    const deadline = requestDeadline(1_000);
    try {
      await expect(
        readBoundedBody(response, deadline, 5),
      ).rejects.toMatchObject({
        name: "MapsError",
        code: "MAPS_RESPONSE_TOO_LARGE",
      });
    } finally {
      deadline.dispose();
    }
  });

  it("rejects undecodable UTF-8 bytes as a malformed response", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xfe, 0x00]));
        controller.close();
      },
    });
    const response = jsonResponse(stream);
    const deadline = requestDeadline(1_000);
    try {
      await expect(
        readBoundedBody(response, deadline, 10_000),
      ).rejects.toMatchObject({
        name: "MapsError",
        code: "MAPS_MALFORMED_RESPONSE",
      });
    } finally {
      deadline.dispose();
    }
  });

  it("surfaces an already-elapsed deadline as a provider timeout", async () => {
    const response = jsonResponse(encoder.encode("data"));
    const controller = new AbortController();
    controller.abort(new DOMException("Maps deadline elapsed", "TimeoutError"));
    await expect(
      readBoundedBody(
        response,
        { signal: controller.signal, dispose: () => {} },
        10_000,
      ),
    ).rejects.toMatchObject({
      name: "MapsError",
      code: "MAPS_PROVIDER_TIMEOUT",
    });
  });

  it("carries status and limit context on the too-large error", async () => {
    const response = jsonResponse(null, {}, 413);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const withBody = {
      headers: new Headers({ "content-length": "99999" }),
      status: 413,
      body: { cancel },
    } as unknown as Response;
    void response;
    const deadline = requestDeadline(1_000);
    try {
      await expect(
        readBoundedBody(withBody, deadline, 10),
      ).rejects.toMatchObject({
        code: "MAPS_RESPONSE_TOO_LARGE",
        context: { status: 413, limit: 10 },
      });
    } finally {
      deadline.dispose();
    }
  });

  it("is instance of MapsError and ElizaError", async () => {
    const response = jsonResponse(encoder.encode("data"));
    const controller = new AbortController();
    controller.abort(new DOMException("Maps deadline elapsed", "TimeoutError"));
    const error = await readBoundedBody(
      response,
      { signal: controller.signal, dispose: () => {} },
      10_000,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MapsError);
  });
});
