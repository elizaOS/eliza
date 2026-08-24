/**
 * Unit coverage for safe EventSource opening: rejects non-http(s) schemes and
 * unparseable URLs, degrades to null when EventSource is unavailable or throws,
 * and only constructs for valid http(s) URLs. Deterministic — no network.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { openEventSource } from "./event-source";

const originalEventSource = (globalThis as unknown as { EventSource?: unknown })
  .EventSource;
const originalWindow = (globalThis as unknown as { window?: unknown }).window;

afterEach(() => {
  (globalThis as unknown as { EventSource?: unknown }).EventSource =
    originalEventSource;
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  vi.restoreAllMocks();
});

describe("openEventSource", () => {
  test("returns null when EventSource is undefined", () => {
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      undefined;
    expect(openEventSource("https://example.com/sse")).toBeNull();
  });

  test("returns null for unparseable URL", () => {
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      vi.fn() as unknown as typeof EventSource;
    expect(openEventSource("http://[invalid")).toBeNull();
  });

  test("returns null for non-http(s) protocols", () => {
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      vi.fn() as unknown as typeof EventSource;
    expect(openEventSource("eliza-local-agent://ipc/events")).toBeNull();
    expect(openEventSource("ftp://example.com/file")).toBeNull();
    expect(openEventSource("ws://example.com/socket")).toBeNull();
    expect(openEventSource("file:///etc/passwd")).toBeNull();
  });

  test("returns null for relative URL that resolves to non-http base", () => {
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      vi.fn() as unknown as typeof EventSource;
    (globalThis as unknown as { window?: unknown }).window = {
      location: { href: "eliza-local-agent://ipc/" },
    } as unknown as Window;
    expect(openEventSource("/sse")).toBeNull();
  });

  test("constructs EventSource for valid http(s) URLs", () => {
    const MockEventSource = vi.fn(function (this: unknown, url: string) {
      (this as Record<string, unknown>).url = url;
    }) as unknown as typeof EventSource;
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      MockEventSource;
    const es = openEventSource("https://example.com/sse");
    expect(MockEventSource).toHaveBeenCalledWith(
      "https://example.com/sse",
      undefined,
    );
    expect(es).toBeInstanceOf(MockEventSource);
  });

  test("passes init through", () => {
    const MockEventSource = vi.fn() as unknown as typeof EventSource;
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      MockEventSource;
    openEventSource("https://example.com/sse", {
      withCredentials: true,
    } as EventSourceInit);
    expect(MockEventSource).toHaveBeenCalledWith("https://example.com/sse", {
      withCredentials: true,
    });
  });

  test("returns null when constructor throws", () => {
    const ThrowingEventSource = vi.fn(() => {
      throw new Error("The operation is insecure.");
    }) as unknown as typeof EventSource;
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      ThrowingEventSource;
    expect(openEventSource("https://example.com/sse")).toBeNull();
    expect(openEventSource("https://example.com/sse")).toBeNull();
  });

  test("handles http and https explicitly", () => {
    const MockEventSource = vi.fn() as unknown as typeof EventSource;
    (globalThis as unknown as { EventSource?: unknown }).EventSource =
      MockEventSource;
    expect(openEventSource("http://example.com/sse")).not.toBeNull();
    expect(openEventSource("https://example.com/sse")).not.toBeNull();
  });
});
