import { afterAll, expect, test } from "bun:test";
import { fetchPinnedResponse } from "../shared/pinned-response";

let redirectTargetRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/empty":
        return new Response(null, { status: 204 });
      case "/redirect":
        return Response.redirect(new URL("/target", request.url), 302);
      case "/target":
        redirectTargetRequests++;
        return new Response("unexpected");
      case "/large":
        return new Response("x".repeat(1024));
      case "/stream":
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(1024));
              c.close();
            },
          }),
        );
      case "/slow":
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1]));
            },
          }),
        );
      default:
        return new Response(await request.text());
    }
  },
});
afterAll(() => server.stop(true));
const url = (path: string) => new URL(path, `http://127.0.0.1:${server.port}`);
const limits = { timeoutMs: 1000, maxBytes: 100 };

test("pinned transport preserves form bodies and refuses redirect traversal", async () => {
  expect(
    await (
      await fetchPinnedResponse(
        url("/"),
        { method: "POST", body: "code=abc&grant_type=authorization_code" },
        limits,
      )
    ).text(),
  ).toBe("code=abc&grant_type=authorization_code");
  await expect(
    fetchPinnedResponse(
      url("/redirect"),
      {},
      { ...limits, rejectRedirects: true },
    ),
  ).rejects.toMatchObject({ code: "LOGIN_HTTP_REDIRECT" });
  expect(redirectTargetRequests).toBe(0);
});

test("pinned transport rejects both declared and streamed oversized responses", async () => {
  await expect(
    fetchPinnedResponse(url("/large"), {}, limits),
  ).rejects.toThrow();
  await expect(
    fetchPinnedResponse(url("/stream"), {}, limits),
  ).rejects.toThrow();
});

test("pinned transport deadline covers a stalled response body", async () => {
  await expect(
    fetchPinnedResponse(url("/slow"), {}, { ...limits, timeoutMs: 50 }),
  ).rejects.toMatchObject({ code: "LOGIN_HTTP_TIMEOUT" });
}, 2000);

test("pinned transport honors caller cancellation before and after headers", async () => {
  const controller = new AbortController();
  const result = fetchPinnedResponse(
    url("/slow"),
    { signal: controller.signal },
    limits,
  );
  setTimeout(() => controller.abort(new Error("caller cancelled")), 50);
  await expect(result).rejects.toThrow("caller cancelled");
  await expect(
    fetchPinnedResponse(url("/"), { signal: controller.signal }, limits),
  ).rejects.toThrow("caller cancelled");
}, 2000);

test("pinned transport releases bodyless success responses", async () => {
  const response = await fetchPinnedResponse(url("/empty"), {}, limits);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
});
