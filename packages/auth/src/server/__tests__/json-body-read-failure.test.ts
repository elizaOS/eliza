import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { safeJsonParse } from "../api/services/context";

/**
 * `safeJsonParse` exists so a route can answer 400 for a body the client
 * failed to send as JSON. It must not also answer "no body" when the body
 * could not be read at all — a dropped upload, an aborted stream or an
 * already-consumed body is a transport fault, not a malformed request.
 */
function probeApp() {
  const app = new Hono();
  app.post("/probe", async (c) => {
    const body = await safeJsonParse<{ token?: string }>(c);
    return c.json({ sawAbsentBody: body === null });
  });
  // Mirror the production boundary: only a typed HTTP failure is translated,
  // never a transport error.
  app.onError((error, c) =>
    c.json({ ok: false, error: (error as Error).message }, 500),
  );
  return app;
}

function requestWithBrokenBody(): Request {
  return new Request("http://localhost/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error("socket hang up"));
      },
    }),
    duplex: "half",
  } as RequestInit);
}

describe("safeJsonParse", () => {
  test("propagates a request body read failure", async () => {
    const response = await probeApp().request(requestWithBrokenBody());
    // Before the fix this resolved to null and the route answered 200 with
    // `sawAbsentBody: true`, reporting a dropped upload as an empty body.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "socket hang up",
    });
  });

  test("still treats an unparseable body as absent", async () => {
    const response = await probeApp().request(
      new Request("http://localhost/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sawAbsentBody: true });
  });
});
