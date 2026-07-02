/**
 * The blob host (`R2_PUBLIC_HOST`) must serve public R2 objects from the
 * worker itself: the wildcard `*.elizacloud.ai/*` route shadows any R2 custom
 * domain, so before this handler every minted public URL (avatars, image
 * generations, voice samples) 404'd on the JSON router — and OpenAI's
 * moderation-by-URL failed image generation closed on every env.
 */

import { describe, expect, test } from "bun:test";
import { serveBlobHostRequest } from "./blob-host";

function makeEnv(
  objects: Record<string, { body: string; contentType?: string }>,
  publicHost?: string,
) {
  const bucket = {
    async get(key: string) {
      const hit = objects[key];
      if (!hit) return null;
      return {
        size: hit.body.length,
        httpEtag: `"etag-${key}"`,
        httpMetadata: { contentType: hit.contentType ?? "image/png" },
        async text() {
          return hit.body;
        },
      };
    },
    async put() {
      return undefined;
    },
    async delete() {
      return undefined;
    },
  };
  return {
    BLOB: bucket,
    ...(publicHost ? { R2_PUBLIC_HOST: publicHost } : {}),
  };
}

function req(url: string, method = "GET"): [Request, URL] {
  return [new Request(url, { method }), new URL(url)];
}

describe("serveBlobHostRequest", () => {
  test("serves an existing object with its content-type on the default blob host", async () => {
    const env = makeEnv({
      "generations/images/org/user/img.png": { body: "PNGBYTES" },
    });
    const [request, url] = req(
      "https://blob.elizacloud.ai/generations/images/org/user/img.png",
    );

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toContain("public");
    expect(await res?.text()).toBe("PNGBYTES");
  });

  test("respects R2_PUBLIC_HOST for the per-env host (staging)", async () => {
    const env = makeEnv(
      { "avatars/eliza.png": { body: "AVATAR" } },
      "blob-staging.elizacloud.ai",
    );

    const [hitReq, hitUrl] = req(
      "https://blob-staging.elizacloud.ai/avatars/eliza.png",
    );
    const hit = await serveBlobHostRequest(hitReq, hitUrl, env);
    expect(hit?.status).toBe(200);

    // The default host is NOT served when the env pins a different one —
    // those requests fall through to normal routing.
    const [missReq, missUrl] = req(
      "https://blob.elizacloud.ai/avatars/eliza.png",
    );
    expect(await serveBlobHostRequest(missReq, missUrl, env)).toBeNull();
  });

  test("404s a missing key with the router's JSON error shape", async () => {
    const env = makeEnv({});
    const [request, url] = req(
      "https://blob.elizacloud.ai/generations/nope.png",
    );

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ code: "resource_not_found" });
  });

  test("HEAD returns headers without a body (falls back to get when head is absent)", async () => {
    const env = makeEnv({ "a/b.png": { body: "12345" } });
    const [request, url] = req("https://blob.elizacloud.ai/a/b.png", "HEAD");

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-length")).toBe("5");
    expect(await res?.text()).toBe("");
  });

  test("rejects writes", async () => {
    const env = makeEnv({ "a/b.png": { body: "x" } });
    const [request, url] = req("https://blob.elizacloud.ai/a/b.png", "PUT");

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(405);
    expect(res?.headers.get("allow")).toBe("GET, HEAD");
  });

  test("ignores non-blob hosts entirely", async () => {
    const env = makeEnv({ "a/b.png": { body: "x" } });
    const [request, url] = req("https://api.elizacloud.ai/a/b.png");

    expect(await serveBlobHostRequest(request, url, env)).toBeNull();
  });

  test("decodes URL-encoded keys", async () => {
    const env = makeEnv({ "media/user/1 - fichier été.png": { body: "OK" } });
    const [request, url] = req(
      "https://blob.elizacloud.ai/media/user/1%20-%20fichier%20%C3%A9t%C3%A9.png",
    );

    const res = await serveBlobHostRequest(request, url, env);
    expect(res?.status).toBe(200);
  });
});
