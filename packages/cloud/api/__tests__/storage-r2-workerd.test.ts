/**
 * Exercises the native R2 generation contract inside genuine Workerd: an
 * immutable conditional write, strongly consistent HEAD/GET, and delete.
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
                const key = "__eliza_storage_authority/v2/org/test/object/1";
                if (request.method === "PUT") {
                  const body = await request.arrayBuffer();
                  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
                    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
                  const stored = await env.BLOB.put(key, body, {
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
      headers: { "x-request-digest": "request-one" },
      body: "first",
    });
    expect(await first.json()).toMatchObject({ stored: true, size: 5 });

    const collision = await miniflare.dispatchFetch("https://storage.test/", {
      method: "PUT",
      headers: { "x-request-digest": "request-two" },
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
});
