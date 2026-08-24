/**
 * Unit coverage for the safe EventSource opener used by SSE consumers
 * (client-agent, client-orchestrator-widgets, AddAccountDialog,
 * model-download). Deterministic: runs in the node environment with explicit
 * platform doubles for the EventSource constructor and window.location, so
 * every branch — missing global, unparseable URL, non-http(s) scheme,
 * constructor rejection — is exercised without a live socket.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEventSource } from "./event-source";

class RecordingEventSource {
  static calls: Array<{ url: string; init: EventSourceInit | undefined }> = [];

  constructor(url: string, init?: EventSourceInit) {
    RecordingEventSource.calls.push({ url, init });
  }
}

class ThrowingEventSource {
  constructor() {
    throw new Error("SecurityError: The operation is insecure");
  }
}

describe("openEventSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", undefined);

    expect(openEventSource("https://example.com/stream")).toBeNull();
  });

  it("returns null for an unparseable URL without constructing", () => {
    vi.stubGlobal("EventSource", RecordingEventSource);
    RecordingEventSource.calls = [];

    expect(openEventSource("http://")).toBeNull();
    expect(RecordingEventSource.calls).toHaveLength(0);
  });

  it.each([
    "eliza-local-agent://ipc/events",
    "ws://localhost/sse",
    "file:///tmp/feed",
  ])(
    "returns null for the non-http(s) scheme %s without constructing",
    (url) => {
      vi.stubGlobal("EventSource", RecordingEventSource);
      RecordingEventSource.calls = [];

      expect(openEventSource(url, { withCredentials: true })).toBeNull();
      expect(RecordingEventSource.calls).toHaveLength(0);
    },
  );

  it("constructs with the given URL and init and returns that instance", () => {
    vi.stubGlobal("EventSource", RecordingEventSource);
    RecordingEventSource.calls = [];
    const init = { withCredentials: true };

    const source = openEventSource("https://api.example.com/v1/stream", init);

    expect(source).toBeInstanceOf(RecordingEventSource);
    expect(RecordingEventSource.calls).toEqual([
      { url: "https://api.example.com/v1/stream", init },
    ]);
  });

  it("forwards no init when called without one", () => {
    vi.stubGlobal("EventSource", RecordingEventSource);
    RecordingEventSource.calls = [];

    const source = openEventSource("https://api.example.com/v1/stream");

    expect(source).toBeInstanceOf(RecordingEventSource);
    expect(RecordingEventSource.calls[0].url).toBe(
      "https://api.example.com/v1/stream",
    );
    expect(RecordingEventSource.calls[0].init).toBeUndefined();
  });

  it("accepts a scheme-relative URL resolved against window.location", () => {
    vi.stubGlobal("EventSource", RecordingEventSource);
    RecordingEventSource.calls = [];
    vi.stubGlobal("window", {
      location: { href: "https://app.example.com/x" },
    });

    const source = openEventSource("//cdn.example.com/sse");

    // Resolving "//cdn.example.com/sse" against an https base yields https:;
    // without base resolution new URL() alone would throw and return null.
    expect(source).toBeInstanceOf(RecordingEventSource);
    expect(RecordingEventSource.calls[0].url).toBe("//cdn.example.com/sse");
  });

  it("resolves relative URLs against the http://localhost fallback when window is absent", () => {
    vi.stubGlobal("EventSource", RecordingEventSource);
    RecordingEventSource.calls = [];
    vi.stubGlobal("window", undefined);

    const source = openEventSource("/sse/feed");

    // "/sse/feed" has no base of its own; only the localhost fallback makes
    // it parseable as http:, so reaching the constructor proves that branch.
    expect(source).toBeInstanceOf(RecordingEventSource);
    expect(RecordingEventSource.calls[0].url).toBe("/sse/feed");
  });

  it("returns null instead of throwing when the constructor rejects the URL", () => {
    vi.stubGlobal("EventSource", ThrowingEventSource);
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });

    // Non-http(s) schemes are filtered before construction; this simulates
    // the insecure-context rejection the module header documents — the
    // constructor throwing on an otherwise valid http(s) URL.
    expect(openEventSource("https://example.com/stream")).toBeNull();
  });
});
