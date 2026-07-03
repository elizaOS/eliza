/**
 * The blob host (`R2_PUBLIC_HOST`) must serve public R2 objects from the
 * worker itself: the wildcard `*.elizacloud.ai/*` route shadows any R2 custom
 * domain, so before this handler every minted public URL (avatars, image
 * generations, voice samples) 404'd on the JSON router — and OpenAI's
 * moderation-by-URL failed image generation closed on every env.
 *
 * SECURITY: `env.BLOB` is also the private heavy-payload offload store
 * (`@/lib/storage/object-namespace`), so the handler serves ONLY keys under
 * `PUBLIC_BLOB_PREFIXES` — everything else must 404 without touching the
 * bucket, even when the object exists.
 */

import { describe, expect, test } from "bun:test";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { PUBLIC_BLOB_PREFIXES, serveBlobHostRequest } from "./blob-host";

function makeEnv(
  objects: Record<string, { body: string; contentType?: string }>,
  publicHost?: string,
) {
  const reads: string[] = [];
  const bucket = {
    async get(key: string) {
      reads.push(key);
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
    env: {
      BLOB: bucket,
      ...(publicHost ? { R2_PUBLIC_HOST: publicHost } : {}),
    },
    reads,
  };
}

function req(url: string, method = "GET"): [Request, URL] {
  return [new Request(url, { method }), new URL(url)];
}

describe("serveBlobHostRequest", () => {
  test("serves an existing object with its content-type on the default blob host", async () => {
    const { env } = makeEnv({
      "generations/images/org/user/img.png": { body: "PNGBYTES" },
    });
    const [request, url] = req(
      "https://blob.elizacloud.ai/generations/images/org/user/img.png",
    );

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toContain("public");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res?.headers.get("content-disposition")).toBe("inline");
    expect(await res?.text()).toBe("PNGBYTES");
  });

  test("serves cloud file upload URLs while forcing active types to download", async () => {
    const key = "cloud-files/org-1/2026-07-03/file-1-abc123.svg";
    const { env } = makeEnv({
      [key]: {
        body: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
        contentType: "image/svg+xml",
      },
    });
    const [request, url] = req(`https://blob.elizacloud.ai/${key}`);

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/svg+xml");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res?.headers.get("content-disposition")).toBe("attachment");
    expect(res?.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res?.text()).toContain("<svg");
  });

  test("respects R2_PUBLIC_HOST for the per-env host (staging)", async () => {
    const { env } = makeEnv(
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
    const { env } = makeEnv({});
    const [request, url] = req(
      "https://blob.elizacloud.ai/generations/nope.png",
    );

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ code: "resource_not_found" });
  });

  test("HEAD returns headers without a body (falls back to get when head is absent)", async () => {
    const { env } = makeEnv({ "avatars/a/b.png": { body: "12345" } });
    const [request, url] = req(
      "https://blob.elizacloud.ai/avatars/a/b.png",
      "HEAD",
    );

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-length")).toBe("5");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res?.text()).toBe("");
  });

  test("rejects writes", async () => {
    const { env } = makeEnv({ "avatars/a/b.png": { body: "x" } });
    const [request, url] = req(
      "https://blob.elizacloud.ai/avatars/a/b.png",
      "PUT",
    );

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(405);
    expect(res?.headers.get("allow")).toBe("GET, HEAD");
  });

  test("ignores non-blob hosts entirely", async () => {
    const { env } = makeEnv({ "avatars/a/b.png": { body: "x" } });
    const [request, url] = req("https://api.elizacloud.ai/avatars/a/b.png");

    expect(await serveBlobHostRequest(request, url, env)).toBeNull();
  });

  test("decodes URL-encoded keys under a public prefix", async () => {
    const { env } = makeEnv({
      "avatars/user/1 - fichier été.png": { body: "OK" },
    });
    const [request, url] = req(
      "https://blob.elizacloud.ai/avatars/user/1%20-%20fichier%20%C3%A9t%C3%A9.png",
    );

    const res = await serveBlobHostRequest(request, url, env);
    expect(res?.status).toBe(200);
  });

  test("404s every private offload namespace even when the object exists — without reading the bucket", async () => {
    for (const namespace of Object.values(ObjectNamespaces)) {
      const key = `${namespace}/org-1/2026-07-02/obj-1/body.json`;
      const { env, reads } = makeEnv({
        [key]: { body: '{"private":true}', contentType: "application/json" },
      });

      for (const method of ["GET", "HEAD"]) {
        const [request, url] = req(`https://blob.elizacloud.ai/${key}`, method);
        const res = await serveBlobHostRequest(request, url, env);
        expect(res?.status).toBe(404);
      }
      expect(reads).toEqual([]);
    }
  });

  test("404s non-allowlisted prefixes that mint URLs only as opaque handles", async () => {
    // documents-pre-upload/ blobUrls are round-trip tokens (the server reads
    // them via the binding); media/ has no live writer. Neither is public.
    for (const key of [
      "documents-pre-upload/user-1/123-abc-doc.txt",
      "media/user/file.png",
    ]) {
      const { env, reads } = makeEnv({ [key]: { body: "PRIVATE" } });
      const [request, url] = req(`https://blob.elizacloud.ai/${key}`);

      const res = await serveBlobHostRequest(request, url, env);

      expect(res?.status).toBe(404);
      expect(await res?.json()).toMatchObject({ code: "resource_not_found" });
      expect(reads).toEqual([]);
    }
  });

  test("allowlist prefixes all end with a slash so sibling namespaces cannot match", () => {
    // e.g. "generations/" must not accidentally allow "generation-artifacts/…".
    for (const prefix of PUBLIC_BLOB_PREFIXES) {
      expect(prefix.endsWith("/")).toBe(true);
    }
  });

  test("serves SVG under a public prefix as a download with nosniff", async () => {
    const { env } = makeEnv({
      "avatars/users/org/user/pic.svg": {
        body: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
        contentType: "image/svg+xml",
      },
    });
    const [request, url] = req(
      "https://blob.elizacloud.ai/avatars/users/org/user/pic.svg",
    );

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res?.headers.get("content-disposition")).toBe("attachment");
    expect(res?.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("forces HTML and unknown content types to download", async () => {
    const { env } = makeEnv({
      "generations/images/org/user/evil.html": {
        body: "<script>alert(1)</script>",
        contentType: "text/html",
      },
      "generations/images/org/user/blob.bin": {
        body: "BYTES",
        contentType: "application/octet-stream",
      },
    });

    for (const name of ["evil.html", "blob.bin"]) {
      const [request, url] = req(
        `https://blob.elizacloud.ai/generations/images/org/user/${name}`,
      );
      const res = await serveBlobHostRequest(request, url, env);
      expect(res?.status).toBe(200);
      expect(res?.headers.get("content-disposition")).toBe("attachment");
      expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("404s malformed percent-encoding instead of throwing", async () => {
    const { env, reads } = makeEnv({});
    // `%A` truncated escape → decodeURIComponent throws URIError.
    const [request, url] = req("https://blob.elizacloud.ai/avatars/%E0%A4%A");

    const res = await serveBlobHostRequest(request, url, env);

    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ code: "resource_not_found" });
    expect(reads).toEqual([]);
  });
});
