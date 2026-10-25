/**
 * Exercises genuine Workerd contracts through Miniflare: native R2 generation
 * semantics and delivery of an early response after cancelling an unfinished
 * inbound streaming request body. This does not exercise Hono or module mocks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";

describe("native storage R2 contract in Workerd", () => {
  let miniflare: Miniflare;

  beforeAll(() => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-04-01",
      modules: [
        {
          type: "ESModule",
          path: "storage-worker.mjs",
          contents: `
            export default {
              async fetch(request, env) {
                if (new URL(request.url).pathname === "/reject-unbounded-upload") {
                  if (request.body === null) {
                    return new Response("missing request body", { status: 500 });
                  }
                  await request.body.cancel();
                  return new Response("length required", { status: 411 });
                }
                const key = "__eliza_storage_authority/v2/org/test/object/1";
                if (request.method === "PUT") {
                  const digest = request.headers.get("x-content-sha256");
                  const stored = await env.BLOB.put(key, request.body, {
                    onlyIf: { etagDoesNotMatch: "*" },
                    sha256: digest,
                    customMetadata: { requestDigest: request.headers.get("x-request-digest") },
                  });
                  const head = await env.BLOB.head(key);
                  return Response.json({ stored: stored !== null, size: head?.size, digest });
                }
                if (request.method === "DELETE") {
                  await env.BLOB.delete(key);
                  return Response.json({ absent: (await env.BLOB.head(key)) === null });
                }
                const object = await env.BLOB.get(key);
                return object ? new Response(object.body) : new Response(null, { status: 404 });
              }
            };
          `,
        },
      ],
      r2Buckets: ["BLOB"],
    });
  });

  afterAll(async () => {
    await miniflare?.dispose();
  });

  test("keeps deterministic generations immutable and observes deletion immediately", async () => {
    const first = await miniflare.dispatchFetch("https://storage.test/", {
      method: "PUT",
      headers: {
        "x-request-digest": "request-one",
        "x-content-sha256":
          "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
      },
      body: "first",
    });
    expect(await first.json()).toMatchObject({ stored: true, size: 5 });

    const collision = await miniflare.dispatchFetch("https://storage.test/", {
      method: "PUT",
      headers: {
        "x-request-digest": "request-two",
        "x-content-sha256":
          "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4",
      },
      body: "second",
    });
    expect(await collision.json()).toMatchObject({ stored: false, size: 5 });
    expect(
      await (await miniflare.dispatchFetch("https://storage.test/")).text(),
    ).toBe("first");

    const removed = await miniflare.dispatchFetch("https://storage.test/", {
      method: "DELETE",
    });
    expect(await removed.json()).toEqual({ absent: true });
    expect(
      (await miniflare.dispatchFetch("https://storage.test/")).status,
    ).toBe(404);
  });

  test("flushes 411 after cancelling an unfinished streaming upload", async () => {
    let uploadFinished = false;
    let releaseUpload: (() => void) | undefined;
    const uploadRelease = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial upload"));
      },
      async pull(controller) {
        await uploadRelease;
        controller.close();
        uploadFinished = true;
      },
    });

    const timeout = Symbol("timeout");
    const withinDeadline = async <T>(
      promise: Promise<T>,
      milliseconds = 5_000,
    ) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof timeout>((resolve) => {
        timeoutId = setTimeout(() => resolve(timeout), milliseconds);
      });
      try {
        return await Promise.race([promise, deadline]);
      } finally {
        clearTimeout(timeoutId);
      }
    };
    const response = miniflare.dispatchFetch(
      "https://storage.test/reject-unbounded-upload",
      { method: "PUT", body },
    );
    try {
      const result = await withinDeadline(response);

      expect(result).not.toBe(timeout);
      if (result === timeout) return;
      expect(result.status).toBe(411);
      expect(await result.text()).toBe("length required");
      expect(uploadFinished).toBe(false);

      // Miniflare does not currently forward Workerd's body cancellation to
      // the host ReadableStream cancel hook. The observable transport proof is
      // therefore the completed 411 while this producer is still unfinished.
    } finally {
      releaseUpload?.();
      await withinDeadline(
        response.then(
          () => undefined,
          () => undefined,
        ),
        1_000,
      );
    }
  }, 10_000);
});
