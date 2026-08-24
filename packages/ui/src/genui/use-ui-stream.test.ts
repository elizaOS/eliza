/** Verifies the GenUI stream hook through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers use-ui-stream end to end: the pure officialSpecToEliza conversion and
 * the useUIStream wrapper driving the REAL @json-render/react engine. Fetch is
 * stubbed at the network boundary only, returning JSONL patch streams the
 * engine parses exactly as production does; every assertion targets this
 * module's own behaviour — spec conversion, send-option assembly, completion
 * and error plumbing — never a mock's internal bookkeeping.
 */

import type { Spec as OfficialSpec } from "@json-render/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaGenUiSendOptions, ElizaGenUiSpec } from "./types";
import { officialSpecToEliza, useUIStream } from "./use-ui-stream";

const API_URL = "https://agent.test/genui";

const encoder = new TextEncoder();

const streamResponse = (...lines: unknown[]): Response => {
  const body = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200 },
  );
};

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status });

const CARD_PATCH_LINES = [
  { op: "replace", path: "/root", value: "root-1" },
  {
    op: "add",
    path: "/elements/card-1",
    value: { type: "Card", props: { title: "Hello" }, children: ["text-1"] },
  },
  {
    op: "add",
    path: "/elements/text-1",
    value: { type: "Text", props: { value: "World" } },
  },
  { op: "add", path: "/state", value: { count: 2 } },
];

const CONVERTED_CARD_SPEC = {
  version: "0.1",
  root: "root-1",
  components: [
    { id: "card-1", component: "Card", children: ["text-1"], title: "Hello" },
    { id: "text-1", component: "Text", value: "World" },
  ],
  data: { count: 2 },
};

interface RecordedCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

const stubFetchResponding = (
  respond: () => Response | Promise<Response>,
): { calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return await respond();
    }),
  );
  return { calls };
};

const requestPayload = (
  call: RecordedCall | undefined,
): { prompt: string; context: Record<string, unknown> } =>
  JSON.parse(String(call?.init?.body)) as {
    prompt: string;
    context: Record<string, unknown>;
  };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("officialSpecToEliza", () => {
  it("maps null to null", () => {
    expect(officialSpecToEliza(null)).toBeNull();
  });

  it("converts an empty spec with defaults for missing state", () => {
    expect(officialSpecToEliza({ root: "", elements: {} })).toEqual({
      version: "0.1",
      root: "",
      components: [],
      data: undefined,
    });
  });

  it("falls back to an empty root when the official root is missing", () => {
    const converted = officialSpecToEliza({
      elements: {},
    } as unknown as OfficialSpec);
    expect(converted?.root).toBe("");
    expect(converted?.version).toBe("0.1");
  });

  it("maps elements into components and passes state through as data", () => {
    const spec: OfficialSpec = {
      root: "r",
      elements: {
        card: { type: "Card", props: { title: "Hi" }, children: [] },
      },
      state: { open: true },
    };
    expect(officialSpecToEliza(spec)).toEqual({
      version: "0.1",
      root: "r",
      components: [
        { id: "card", component: "Card", children: [], title: "Hi" },
      ],
      data: { open: true },
    });
  });

  it("labels elements without a type as unknown", () => {
    const spec = {
      root: "r",
      elements: { mystery: { props: null } },
    } as unknown as OfficialSpec;
    const components = officialSpecToEliza(spec)?.components ?? [];
    expect(components).toHaveLength(1);
    expect(components[0]?.component).toBe("unknown");
  });

  it("keeps element order and omits absent children instead of writing undefined", () => {
    const spec = {
      root: "r",
      elements: {
        plain: { type: "Row" },
        nulled: { type: "Box", props: null },
      },
    } as unknown as OfficialSpec;
    const components = officialSpecToEliza(spec)?.components ?? [];
    expect(components[0]).toEqual({ id: "plain", component: "Row" });
    expect("children" in (components[0] ?? {})).toBe(false);
    expect(components[1]).toEqual({ id: "nulled", component: "Box" });
    expect("props" in (components[1] ?? {})).toBe(false);
  });
});

describe("useUIStream", () => {
  it("starts idle with a null spec and no error", () => {
    stubFetchResponding(() => streamResponse(...CARD_PATCH_LINES));
    const { result } = renderHook(() => useUIStream({ api: API_URL }));
    expect(result.current.spec).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });

  it("posts to the configured endpoint, defaulting the prompt to an empty string and forwarding headers", async () => {
    const { calls } = stubFetchResponding(() => streamResponse());
    const headers = { authorization: "Bearer token-1" };
    const { result } = renderHook(() => useUIStream({ api: API_URL, headers }));

    await act(async () => {
      await result.current.send();
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(API_URL);
    expect(calls[0]?.init?.method).toBe("POST");
    const payload = requestPayload(calls[0]);
    expect(payload.prompt).toBe("");
    expect(payload.context.headers).toEqual(headers);
  });

  it("sends an explicit prompt when provided", async () => {
    const { calls } = stubFetchResponding(() => streamResponse());
    const { result } = renderHook(() => useUIStream({ api: API_URL }));

    await act(async () => {
      await result.current.send({ prompt: "build me a dashboard" });
    });

    expect(requestPayload(calls[0]).prompt).toBe("build me a dashboard");
  });

  it("layers per-send body over the initial body", async () => {
    const { calls } = stubFetchResponding(() => streamResponse());
    const { result } = renderHook(() =>
      useUIStream({
        api: API_URL,
        body: { mode: "fast", keep: 1 },
      }),
    );

    const sendOptions: ElizaGenUiSendOptions = {
      prompt: "p",
      body: { mode: "slow", extra: 2 },
    };
    await act(async () => {
      await result.current.send(sendOptions);
    });

    expect(requestPayload(calls[0]).context).toEqual({
      previousSpec: null,
      mode: "slow",
      keep: 1,
      extra: 2,
      headers: {},
    });
  });

  it("passes the previous turn's raw official spec as previousSpec on later sends", async () => {
    const { calls } = stubFetchResponding(() =>
      streamResponse(...CARD_PATCH_LINES),
    );
    const { result } = renderHook(() => useUIStream({ api: API_URL }));

    await act(async () => {
      await result.current.send({ prompt: "first" });
    });
    expect(requestPayload(calls[0]).context.previousSpec).toBeNull();

    await act(async () => {
      await result.current.send({ prompt: "second" });
    });
    const previous = requestPayload(calls[1]).context.previousSpec as {
      root?: unknown;
      elements?: unknown;
    };
    expect(previous.root).toBe("root-1");
    expect(previous.elements).toBeTruthy();
    expect(Array.isArray(previous.elements)).toBe(false);
  });

  it("streams patches into the converted Eliza spec", async () => {
    stubFetchResponding(() => streamResponse(...CARD_PATCH_LINES));
    const { result } = renderHook(() =>
      useUIStream({
        api: API_URL,
        body: { session: "s-1" },
      }),
    );

    await act(async () => {
      await result.current.send({ prompt: "render" });
    });

    expect(result.current.spec).toEqual(CONVERTED_CARD_SPEC);
    expect(result.current.error).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it("delivers the completed spec to onComplete in Eliza component-array form", async () => {
    stubFetchResponding(() => streamResponse(...CARD_PATCH_LINES));
    const completions: (ElizaGenUiSpec | null)[] = [];
    const { result } = renderHook(() =>
      useUIStream({
        api: API_URL,
        onComplete: (spec) => {
          completions.push(spec);
        },
      }),
    );

    await act(async () => {
      await result.current.send();
    });

    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual(CONVERTED_CARD_SPEC);
    expect("elements" in (completions[0] ?? {})).toBe(false);
  });

  it("raises isStreaming only while the request is in flight", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    stubFetchResponding(async () => {
      await gate;
      return streamResponse(...CARD_PATCH_LINES);
    });
    const { result } = renderHook(() => useUIStream({ api: API_URL }));

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.send();
    });
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      releaseGate();
      await pending;
    });
    expect(result.current.isStreaming).toBe(false);
  });

  it("surfaces HTTP failures through error state and onError, then settles streaming", async () => {
    stubFetchResponding(() => jsonResponse(500, { message: "boom" }));
    const onError = vi.fn();
    const { result } = renderHook(() => useUIStream({ api: API_URL, onError }));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(result.current.isStreaming).toBe(false);
  });

  it("seeds spec with the empty baseline when a send starts, keeping it across failures", async () => {
    stubFetchResponding(() => jsonResponse(500, { message: "boom" }));
    const { result } = renderHook(() => useUIStream({ api: API_URL }));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.spec).toEqual({
      version: "0.1",
      root: "",
      components: [],
      data: undefined,
    });
  });

  it("clears the accumulated spec on reset", async () => {
    stubFetchResponding(() => streamResponse(...CARD_PATCH_LINES));
    const { result } = renderHook(() => useUIStream({ api: API_URL }));

    await act(async () => {
      await result.current.send();
    });
    expect(result.current.spec).not.toBeNull();

    act(() => {
      result.current.reset();
    });
    expect(result.current.spec).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
