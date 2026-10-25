import { expect, test, vi } from "vitest";
import { createWebFetchAction } from "./actions/web-fetch-core";
import { createWebFetchEdgeAction } from "./edge";

const call = (
  action: ReturnType<typeof createWebFetchEdgeAction>,
  options: unknown,
) => {
  if (!action.handler) throw new Error("Canonical WEB_FETCH handler missing");
  return action.handler({} as never, {} as never, undefined, options as never);
};
const url = "https://api.example.com/value?ids=bitcoin&vs_currencies=usd";
const envelope = (source = url) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          extract_id: "e",
          results: [
            {
              url: source,
              title: "API",
              excerpts: ['{"bitcoin":{"usd":82299}}'],
              full_content: null,
            },
          ],
          errors: [],
        }),
      },
    ],
  },
});
test("canonical edge action runs without a Node process global", async () => {
  const action = createWebFetchAction(async () => ({
    ok: true,
    status: 200,
    url,
    contentType: "text/plain",
    text: "public result",
    truncated: false,
  }));
  if (!action.validate)
    throw new Error("Canonical WEB_FETCH validation missing");
  let validation: ReturnType<NonNullable<typeof action.validate>>;
  let result: ReturnType<typeof call>;
  vi.stubGlobal("process", undefined);
  try {
    validation = action.validate({} as never, {} as never);
    result = call(action, { url });
  } finally {
    vi.unstubAllGlobals();
  }
  const [enabled, response] = await Promise.all([validation, result]);
  expect(enabled).toBe(true);
  expect(response?.text).toBe("public result");
});
test("canonical factory retains Node direct JSON extraction and original metadata", async () => {
  const action = createWebFetchAction(async () => ({
    ok: true,
    status: 200,
    url,
    contentType: "application/json",
    text: '{"bitcoin":{"usd":82299}}',
    truncated: false,
  }));
  const r = await call(action, { url, extract: "bitcoin.usd" });
  expect(r?.success).toBe(true);
  expect(r?.text).toBe("82299");
  expect(r?.data).toMatchObject({
    status: 200,
    content_type: "application/json",
    kind: "json",
  });
  expect(action.roleGate).toEqual({ minRole: "ADMIN" });
  expect(r?.data?.retrieved_at_basis).toBe(
    "HTTP retrieval completed; not the source publication or market update time",
  );
  const unavailable = createWebFetchAction(async () => ({
    ok: false,
    status: 503,
    url,
    contentType: "text/plain",
    text: "",
    truncated: false,
  }));
  expect((await call(unavailable, { url }))?.text).toContain(
    "failed upstream; try another endpoint or WEB_SEARCH",
  );
});
test("edge canonical action rejects private credentialed and sensitive URLs before dispatch", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const url of [
      "https://127.0.0.1/a",
      "https://localhost/a",
      "https://user:pass@example.com/a",
      "https://example.com/a?token=secret",
    ]) {
      const result = await call(createWebFetchEdgeAction(), { url });
      expect(result?.success).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
test("edge returns exact single-URL provider evidence without origin status or fake JSON extraction", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(input).toBe("https://search.parallel.ai/mcp");
      const req = JSON.parse(String(init?.body));
      expect(req.params.name).toBe("web_fetch");
      expect(req.params.arguments.urls).toEqual([url]);
      expect(req.params.arguments.full_content).toBe(true);
      return Response.json(envelope());
    });
  try {
    const action = createWebFetchEdgeAction();
    const result = await call(action, { url, extract: "bitcoin.usd" });
    expect(action.roleGate).toEqual({ minRole: "GUEST" });
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      provider: "parallel",
      read_method: "provider_extract",
      kind: "provider-extract",
      extract_applied: false,
    });
    expect(result?.data?.status).toBeUndefined();
    expect(result?.data?.content_type).toBeUndefined();
    expect(JSON.parse(result?.text ?? "{}").url).toBe(url);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});
test("provider URL mismatch and empty or partial responses never become successful reads", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const mismatched = envelope("https://other.example.com/a");
    const empty = envelope();
    empty.result.content[0].text = JSON.stringify({
      results: [{ url, title: "API", excerpts: [" "], full_content: null }],
      errors: [],
    });
    const partial = envelope();
    partial.result.content[0].text = JSON.stringify({
      results: [{ url, title: "API", excerpts: ["real partial"] }],
      errors: [{ url }],
    });
    for (const response of [mismatched, empty, partial]) {
      fetch.mockResolvedValueOnce(Response.json(response));
      expect((await call(createWebFetchEdgeAction(), { url }))?.success).toBe(
        false,
      );
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    fetch.mockRestore();
  }
});
test("caller cancellation is preserved and does not dispatch", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await expect(
      call(createWebFetchEdgeAction(), { url, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test("trusted API origin uses one no-store GET and the canonical JSON extraction", async () => {
  const target = "https://wttr.in/35.6895,139.6917?format=j1";
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(input).toBe(target);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "manual",
        cache: "no-store",
      });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({
        current_condition: [{ temp_C: "22", observation_time: "02:00 AM" }],
        nearest_area: [{ areaName: [{ value: "Tokyo" }] }],
        weather: [{ date: "2026-10-13" }],
      });
    });
  try {
    const out = await call(createWebFetchEdgeAction(), {
      url: target,
      extract: "current_condition",
    });
    expect(out?.success).toBe(true);
    expect(JSON.parse(out?.text ?? "null")).toEqual([
      { temp_C: "22", observation_time: "02:00 AM" },
    ]);
    expect(out?.data).toMatchObject({
      action: "WEB_FETCH",
      url: target,
      final_url: target,
      status: 200,
      content_type: "application/json",
      kind: "json",
      truncated: false,
    });
    expect(out?.data?.provider).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});

test("only exact trusted origins use HTTP and no public URL can smuggle credentials or ports", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ bitcoin: { usd: 1 } }));
  try {
    const action = createWebFetchEdgeAction();
    const target =
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
    expect(
      (await call(action, { url: target, extract: "bitcoin.usd" }))?.text,
    ).toBe("1");
    expect(fetch.mock.calls[0][0]).toBe(target);
    for (const target of [
      "https://wttr.in:8443/Tokyo",
      "https://user:pass@wttr.in/Tokyo",
      "https://wttr.in/Tokyo?api_key=secret",
      "http://wttr.in/Tokyo",
    ])
      expect((await call(action, { url: target }))?.success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});

test("trusted API redirects and binary responses fail without following or MCP fallback", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const response of [
      new Response("redirect", {
        status: 302,
        headers: { Location: "https://127.0.0.1/private" },
      }),
      new Response("binary", {
        headers: { "content-type": "application/octet-stream" },
      }),
    ]) {
      fetch.mockResolvedValueOnce(response);
      expect(
        (
          await call(createWebFetchEdgeAction(), {
            url: "https://wttr.in/35.6895,139.6917?format=j1",
          })
        )?.success,
      ).toBe(false);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(([input]) =>
        String(input).startsWith("https://wttr.in/"),
      ),
    ).toBe(true);
  } finally {
    fetch.mockRestore();
  }
});

test("trusted API oversized and invalid UTF-8 bodies are rejected whole", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const body of [new Uint8Array(262145), new Uint8Array([0xc3, 0x28])]) {
      fetch.mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
      expect(
        (
          await call(createWebFetchEdgeAction(), {
            url: "https://wttr.in/35.6895,139.6917?format=j1",
          })
        )?.success,
      ).toBe(false);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    fetch.mockRestore();
  }
});

test("trusted API caller cancellation cancels a stalled body and never retries", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(
      new ReadableStream({
        start() {
          queueMicrotask(() => controller.abort(new Error("caller cancelled")));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    await expect(
      call(createWebFetchEdgeAction(), {
        url: "https://wttr.in/35.6895,139.6917?format=j1",
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled");
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});

test("trusted API deadline cancels a stalled body without a provider retry", async () => {
  vi.useFakeTimers();
  let cancelled = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  try {
    const pending = call(createWebFetchEdgeAction(), {
      url: "https://wttr.in/35.6895,139.6917?format=j1",
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect((await pending)?.success).toBe(false);
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
    vi.useRealTimers();
  }
});

test("trusted API oversized body fails promptly even when cancellation never settles", async () => {
  let cancelStarted = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(262145));
        },
        cancel() {
          cancelStarted = true;
          return new Promise<void>(() => {});
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  try {
    const result = await call(createWebFetchEdgeAction(), {
      url: "https://wttr.in/35.6895,139.6917?format=j1",
    });
    expect(result?.success).toBe(false);
    expect(cancelStarted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
}, 1000);

test("Wttr JSON API rejects ambiguous names and invalid coordinate bounds before HTTP", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const path of [
      "Tokyo",
      "Tokyo,Japan",
      "91,139",
      "35,181",
      "NaN,139",
      "35.6",
      "35.6,139.7/extra",
    ]) {
      const out = await call(createWebFetchEdgeAction(), {
        url: `https://wttr.in/${path}?format=j1`,
      });
      expect(out?.success).toBe(false);
      expect(out?.text).toContain("coordinates");
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test("Wttr named j2 and alternate formats reject ambiguous locations before HTTP", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Ambiguous Wttr request reached HTTP");
  });
  try {
    for (const query of [
      "format=j2",
      "format=j2&format=j1",
      "format=j1&format=j2",
      "format=J2",
      "format=%j2",
      "",
    ]) {
      const out = await call(createWebFetchEdgeAction(), {
        url: `https://wttr.in/Tokyo${query ? `?${query}` : ""}`,
      });
      expect(out?.success).toBe(false);
      expect(out?.text).toContain("coordinates");
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test("Wttr coordinate j2 retains direct JSON extraction", async () => {
  const target = "https://wttr.in/35.6895,139.6917?format=j2";
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response('{"current_condition":[{"temp_C":"22"}]}', {
      headers: { "content-type": "application/json" },
    }),
  );
  try {
    const out = await call(createWebFetchEdgeAction(), {
      url: target,
      extract: "current_condition.0.temp_C",
    });
    expect(out?.success).toBe(true);
    expect(out?.text).toBe('"22"');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(target);
  } finally {
    fetch.mockRestore();
  }
});

test("edge explicitly extracts valid text/plain JSON while preserving MIME and invalid JSON text", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    fetch.mockResolvedValueOnce(
      new Response(
        '{"current_condition":[{"temp_C":"22"}],"nearest_area":[{"name":"Tokyo"}]}',
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      ),
    );
    const out = await call(createWebFetchEdgeAction(), {
      url: "https://wttr.in/35.6895,139.6917?format=j1",
      extract: "current_condition",
    });
    expect(out?.text).toBe('[{"temp_C":"22"}]');
    expect(out?.data).toMatchObject({
      kind: "json",
      content_type: "text/plain; charset=utf-8",
    });
    expect(out?.text).not.toContain("nearest_area");
    expect(out?.data?.nearest_area).toBeUndefined();
    expect(out?.data?.observationDate).toBeUndefined();
    fetch.mockResolvedValueOnce(
      new Response("{not JSON", { headers: { "content-type": "text/plain" } }),
    );
    const invalid = await call(createWebFetchEdgeAction(), {
      url: "https://wttr.in/35.6895,139.6917?format=j1",
      extract: "current_condition",
    });
    expect(invalid?.text).toBe("{not JSON");
    expect(invalid?.data).toMatchObject({
      kind: "text",
      content_type: "text/plain",
    });
  } finally {
    fetch.mockRestore();
  }
});

test("edge JSON extraction accepts observed bracket syntax without unsafe traversal", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const body =
    '{"current_condition":[{"temp_C":"24"}],"nearest_area":[{"name":"Tokyo"}]}';
  try {
    for (const [extract, expected] of [
      ["current_condition[0]", '{"temp_C":"24"}'],
      ["current_condition[0].temp_C", '"24"'],
      ["current_condition[0].__proto__", body],
      ['nearest_area["0"]', body],
      ["nearest_area[0][0]", body],
    ]) {
      fetch.mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "text/plain" } }),
      );
      const out = await call(createWebFetchEdgeAction(), {
        url: "https://wttr.in/35.6895,139.6917?format=j1",
        extract,
      });
      expect(out?.success).toBe(true);
      expect(out?.text).toBe(expected);
      expect(out?.data?.content_type).toBe("text/plain");
    }
  } finally {
    fetch.mockRestore();
  }
});
