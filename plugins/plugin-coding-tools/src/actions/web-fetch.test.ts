/**
 * Canonical Node WEB_FETCH regressions use the genuine Core SSRF guard with
 * only DNS and HTTP boundaries injected. Cancellation must reach the pinned
 * transport and streamed body; HTML numeric references keep WHATWG decoding.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebHttpTestOverrides,
  __setWebHttpFetchImplForTests,
  __setWebHttpLookupFnForTests,
  __setWebHttpPinnedFetchImplForTests,
} from "../lib/web-http.js";
import { htmlToReadableText, webFetchAction } from "./web-fetch.ts";

afterEach(() => __resetWebHttpTestOverrides());
async function runFetch(parameters: Record<string, string>) {
  if (!webFetchAction.handler)
    throw new Error("Missing canonical fetch handler");
  return webFetchAction.handler({} as never, {} as never, undefined, {
    parameters,
  } as never);
}

describe("htmlToReadableText numeric entities", () => {
  it("decodes C1 numeric references through windows-1252", () => {
    expect(htmlToReadableText("<p>&#128; &#150; &#153; &#x99;</p>")).toBe(
      "€ – ™ ™",
    );
  });

  it("leaves the unassigned C1 slots and &#0; as written", () => {
    expect(
      htmlToReadableText("<p>&#129; &#141; &#143; &#144; &#157; &#0;</p>"),
    ).toBe("&#129; &#141; &#143; &#144; &#157; &#0;");
  });

  it("decodes hex references with an uppercase X marker", () => {
    expect(htmlToReadableText("<p>&#X27; &#X2019; &#X1F600; &#X80;</p>")).toBe(
      "' ’ 😀 €",
    );
  });

  it("keeps astral, surrogate, and ordinary references unchanged in behavior", () => {
    expect(htmlToReadableText("<p>&#128512; &#55296; &#8217; &amp;</p>")).toBe(
      "😀 &#55296; ’ &",
    );
  });
});

it("Node rejects ambiguous Wttr JSON names before HTTP", async () => {
  const fetch = vi.fn();
  __setWebHttpFetchImplForTests(fetch);
  for (const location of ["Tokyo", "91,139", "35,-181"]) {
    const result = await runFetch({
      url: `https://wttr.in/${location}?format=j1`,
    });
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("coordinates");
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("Node extracts explicitly requested text/plain JSON and preserves actual MIME", async () => {
  __setWebHttpLookupFnForTests(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  __setWebHttpPinnedFetchImplForTests(
    async () =>
      new Response(
        '{"current_condition":[{"temp_C":"22"}],"nearest_area":[{"name":"Tokyo"}]}',
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      ),
  );
  const result = await runFetch({
    url: "https://wttr.in/35.6895,139.6917?format=j1",
    extract: "current_condition",
  });
  expect(result?.success).toBe(true);
  expect(result?.text).toBe('[{"temp_C":"22"}]');
  expect(result?.data).toMatchObject({
    kind: "json",
    content_type: "text/plain; charset=utf-8",
  });
});

it("Node JSON extraction supports bounded array indexes and refuses unsafe paths", async () => {
  const body =
    '{"current_condition":[{"temp_C":"24"}],"nested":[[{"value":7}]],"__proto__":{"secret":1}}';
  __setWebHttpLookupFnForTests(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  __setWebHttpPinnedFetchImplForTests(
    async () =>
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
  );
  for (const [extract, expected] of [
    ["current_condition[0].temp_C", '"24"'],
    ["nested[0][0].value", "7"],
    ["current_condition.0.temp_C", '"24"'],
    ...[
      "current_condition[-1]",
      "current_condition[01]",
      "current_condition[0]oops",
      "current_condition.[0]",
      "current_condition[1]",
      "current_condition[9007199254740992]",
      "__proto__.secret",
      "constructor.name",
      "current_condition[0].constructor",
      `nested${"[0]".repeat(16)}`,
    ].map((path) => [path, body]),
  ]) {
    const result = await runFetch({
      url: "https://example.com/weather",
      extract,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toBe(expected);
  }
});

it("Node caller abort reaches the pinned HTTP transport before it settles", async () => {
  const caller = new AbortController();
  const reason = new Error("cancel owned Node read");
  let transportSignal: AbortSignal | null | undefined;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  __setWebHttpLookupFnForTests(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  __setWebHttpPinnedFetchImplForTests(async ({ init }) => {
    transportSignal = init.signal;
    started();
    return new Promise<Response>((resolve, reject) => {
      release = () =>
        resolve(
          new Response("released", {
            headers: { "content-type": "text/plain" },
          }),
        );
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  });
  const pending = webFetchAction.handler({} as never, {} as never, undefined, {
    parameters: { url: "https://example.com" },
    abortSignal: caller.signal,
  } as never);
  const settled = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await ready;
  try {
    caller.abort(reason);
    expect(transportSignal?.aborted).toBe(true);
  } finally {
    release();
  }
  expect(await settled).toEqual({ error: reason });
});

it("Node caller abort cancels a stalled response body and preserves its reason", async () => {
  const caller = new AbortController();
  const reason = new Error("cancel owned Node body");
  const cancel = vi.fn();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  let reading!: () => void;
  const ready = new Promise<void>((resolve) => {
    reading = resolve;
  });
  __setWebHttpLookupFnForTests(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  __setWebHttpPinnedFetchImplForTests(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          pull() {
            reading();
            return new Promise<void>(() => {});
          },
          cancel,
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  );
  const pending = webFetchAction.handler({} as never, {} as never, undefined, {
    parameters: { url: "https://example.com" },
    signal: caller.signal,
  } as never);
  const settled = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await ready;
  try {
    caller.abort(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    if (!cancel.mock.calls.length) bodyController.close();
  }
  expect(await settled).toEqual({ error: reason });
});
