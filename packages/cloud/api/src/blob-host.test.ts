/**
 * Blob-host transport tests exercise public allowlisting and the production
 * mint-to-verify-to-native-R2 path with deterministic in-memory bucket fakes.
 * The fake exposes streaming bodies, metadata-only HEAD, and ranged GETs so
 * assertions distinguish body reads from authorization and metadata checks.
 */

import { describe, expect, test } from "bun:test";
import { ObjectNamespaces } from "../../shared/src/lib/storage/object-namespace";
import { PUBLIC_BLOB_PREFIXES, serveBlobHostRequest } from "./blob-host";
import { mintStorageReadCapabilityUrl } from "./storage-read-capability";

const SIGNED_HOST = "blob-signed.example.test";
const SIGNING_SECRET = "storage-read-test-secret-00000000000000000001";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface StoredObject {
  body: string;
  contentType?: string;
  contentLanguage?: string;
  contentEncoding?: string;
}

type RequestedRange =
  | { offset: number; length?: number }
  | { offset?: number; length: number }
  | { suffix: number };

interface BucketAccess {
  operation: "get" | "head";
  key: string;
  range?: RequestedRange;
  onlyIf?: { etagMatches: string };
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeEnv(
  objects: Record<string, StoredObject>,
  options: {
    publicHost?: string;
    signingSecrets?: string;
    withHead?: boolean;
    conditionalMiss?: boolean;
    getError?: Error;
    headError?: Error;
  } = {},
) {
  const accesses: BucketAccess[] = [];

  function objectFor(key: string, requestedRange?: RequestedRange) {
    const stored = objects[key];
    if (!stored) return null;
    const allBytes = encoder.encode(stored.body);
    let bodyBytes = allBytes;
    let returnedRange: RequestedRange | undefined;

    if (requestedRange && "offset" in requestedRange) {
      const offset = requestedRange.offset ?? 0;
      const length = requestedRange.length ?? allBytes.byteLength - offset;
      bodyBytes = allBytes.slice(offset, offset + length);
      returnedRange = { offset, length: bodyBytes.byteLength };
    } else if (requestedRange && "suffix" in requestedRange) {
      const length = Math.min(requestedRange.suffix, allBytes.byteLength);
      bodyBytes = allBytes.slice(allBytes.byteLength - length);
      returnedRange = { offset: allBytes.byteLength - length, length };
    }

    const httpMetadata = {
      contentType: stored.contentType ?? "image/png",
      contentLanguage: stored.contentLanguage,
      contentEncoding: stored.contentEncoding,
      // Both values must be replaced by the blob host's response policy.
      contentDisposition: 'attachment; filename="stored-name.bin"',
      cacheControl: "public, max-age=86400",
    };
    return {
      body: streamBytes(bodyBytes),
      size: allBytes.byteLength,
      etag: `etag-${key}`,
      httpEtag: `"etag-${key}"`,
      httpMetadata,
      range: returnedRange,
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", httpMetadata.contentType);
        if (httpMetadata.contentLanguage) {
          headers.set("content-language", httpMetadata.contentLanguage);
        }
        if (httpMetadata.contentEncoding) {
          headers.set("content-encoding", httpMetadata.contentEncoding);
        }
        headers.set("content-disposition", httpMetadata.contentDisposition);
        headers.set("cache-control", httpMetadata.cacheControl);
        headers.set("expires", "Wed, 21 Oct 2037 07:28:00 GMT");
        headers.set("access-control-allow-origin", "https://untrusted.test");
      },
      async arrayBuffer() {
        return bodyBytes.buffer.slice(
          bodyBytes.byteOffset,
          bodyBytes.byteOffset + bodyBytes.byteLength,
        );
      },
      async text() {
        return decoder.decode(bodyBytes);
      },
    };
  }

  const bucket = {
    async get(
      key: string,
      getOptions?: {
        range?: RequestedRange;
        onlyIf?: { etagMatches: string };
      },
    ) {
      accesses.push({
        operation: "get" as const,
        key,
        ...(getOptions?.range ? { range: getOptions.range } : {}),
        ...(getOptions?.onlyIf ? { onlyIf: getOptions.onlyIf } : {}),
      });
      if (options.getError) throw options.getError;
      const object = objectFor(key, getOptions?.range);
      return object && options.conditionalMiss && getOptions?.onlyIf
        ? { ...object, body: undefined }
        : object;
    },
    ...(options.withHead
      ? {
          async head(key: string) {
            accesses.push({ operation: "head" as const, key });
            if (options.headError) throw options.headError;
            const object = objectFor(key);
            if (!object) return null;
            return { ...object, body: undefined };
          },
        }
      : {}),
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
      ...(options.publicHost ? { R2_PUBLIC_HOST: options.publicHost } : {}),
      ...(options.signingSecrets
        ? { STORAGE_READ_SIGNING_SECRETS: options.signingSecrets }
        : {}),
    },
    accesses,
  };
}

function req(
  url: string,
  method = "GET",
  headers?: HeadersInit,
): [Request, URL] {
  return [new Request(url, { method, headers }), new URL(url)];
}

async function signedUrl(
  scopedKey: string,
  window: { issuedAt?: number; expiresAt?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return mintStorageReadCapabilityUrl({
    rawSecrets: SIGNING_SECRET,
    host: SIGNED_HOST,
    scopedKey,
    issuedAt: window.issuedAt ?? now - 1,
    expiresAt: window.expiresAt ?? now + 299,
  });
}

describe("serveBlobHostRequest public objects", () => {
  test("preserves cacheable public-prefix serving", async () => {
    const key = "generations/images/org/user/img.png";
    const { env } = makeEnv({ [key]: { body: "PNGBYTES" } });
    const [request, url] = req(`https://blob.eliza.app/${key}`);

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("expires")).toBeNull();
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("content-disposition")).toBe("inline");
    expect(await response?.text()).toBe("PNGBYTES");
  });

  test("forces active public content types to download", async () => {
    const key = "cloud-files/org-1/2026-07-03/file-1-abc123.svg";
    const { env } = makeEnv({
      [key]: {
        body: "<svg xmlns='http://www.w3.org/2000/svg'><script /></svg>",
        contentType: "image/svg+xml",
      },
    });
    const [request, url] = req(`https://blob.eliza.app/${key}`);

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-disposition")).toBe("attachment");
    expect(response?.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
  });

  test("canonicalizes uppercase and default :443 in R2_PUBLIC_HOST", async () => {
    const { env } = makeEnv(
      { "avatars/eliza.png": { body: "AVATAR" } },
      { publicHost: "  BLOB-STAGING.ELIZA.APP:443  " },
    );
    const [hitRequest, hitUrl] = req(
      "https://blob-staging.eliza.app/avatars/eliza.png",
    );
    const [missRequest, missUrl] = req(
      "https://blob.eliza.app/avatars/eliza.png",
    );

    expect((await serveBlobHostRequest(hitRequest, hitUrl, env))?.status).toBe(
      200,
    );
    expect(await serveBlobHostRequest(missRequest, missUrl, env)).toBeNull();
  });

  test("supports configured local hosts with ports", async () => {
    const { env } = makeEnv(
      { "avatars/eliza.png": { body: "AVATAR" } },
      { publicHost: "localhost:8787" },
    );
    const [request, url] = req("https://localhost:8787/avatars/eliza.png");

    expect((await serveBlobHostRequest(request, url, env))?.status).toBe(200);
  });

  test("returns public HEAD metadata without a response body", async () => {
    const { env } = makeEnv({ "avatars/a/b.png": { body: "12345" } });
    const [request, url] = req(
      "https://blob.eliza.app/avatars/a/b.png",
      "HEAD",
    );

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-length")).toBe("5");
    expect(await response?.text()).toBe("");
  });

  test("rejects public writes and ignores non-blob hosts", async () => {
    const { env } = makeEnv({ "avatars/a/b.png": { body: "x" } });
    const [writeRequest, writeUrl] = req(
      "https://blob.eliza.app/avatars/a/b.png",
      "PUT",
    );
    const [otherRequest, otherUrl] = req(
      "https://api.eliza.app/avatars/a/b.png",
    );

    const writeResponse = await serveBlobHostRequest(
      writeRequest,
      writeUrl,
      env,
    );
    expect(writeResponse?.status).toBe(405);
    expect(writeResponse?.headers.get("allow")).toBe("GET, HEAD");
    expect(await serveBlobHostRequest(otherRequest, otherUrl, env)).toBeNull();
  });

  test("decodes URL-encoded public keys", async () => {
    const key = "avatars/user/1 - fichier été.png";
    const { env } = makeEnv({ [key]: { body: "OK" } });
    const [request, url] = req(
      "https://blob.eliza.app/avatars/user/1%20-%20fichier%20%C3%A9t%C3%A9.png",
    );

    expect((await serveBlobHostRequest(request, url, env))?.status).toBe(200);
  });

  test("never reads private offload namespaces without a capability", async () => {
    for (const namespace of Object.values(ObjectNamespaces)) {
      const key = `${namespace}/org-1/2026-07-02/obj-1/body.json`;
      const { env, accesses } = makeEnv({
        [key]: { body: '{"private":true}', contentType: "application/json" },
      });

      for (const method of ["GET", "HEAD"]) {
        const [request, url] = req(`https://blob.eliza.app/${key}`, method);
        expect((await serveBlobHostRequest(request, url, env))?.status).toBe(
          404,
        );
      }
      expect(accesses).toEqual([]);
    }
  });

  test("does not treat opaque-handle namespaces as public", async () => {
    for (const key of [
      "documents-pre-upload/user-1/123-abc-doc.txt",
      "media/user/file.png",
    ]) {
      const { env, accesses } = makeEnv({ [key]: { body: "PRIVATE" } });
      const [request, url] = req(`https://blob.eliza.app/${key}`);

      const response = await serveBlobHostRequest(request, url, env);

      expect(response?.status).toBe(404);
      expect(accesses).toEqual([]);
    }
  });

  test("requires slash-terminated public prefixes", () => {
    for (const prefix of PUBLIC_BLOB_PREFIXES) {
      expect(prefix.endsWith("/")).toBe(true);
    }
  });

  test("404s malformed percent-encoding without bucket access", async () => {
    const { env, accesses } = makeEnv({});
    const [request, url] = req("https://blob.eliza.app/avatars/%E0%A4%A");

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(404);
    expect(accesses).toEqual([]);
  });
});

describe("serveBlobHostRequest signed private objects", () => {
  test("round-trips a production-minted capability to the exact private org key", async () => {
    const key = "org/org-1/attachments/voice/clip.mp3";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      {
        [key]: {
          body: "PRIVATE-AUDIO",
          contentType: "audio/mpeg",
          contentLanguage: "en",
        },
      },
      {
        publicHost: "  BLOB-SIGNED.EXAMPLE.TEST:443  ",
        signingSecrets: SIGNING_SECRET,
        withHead: true,
      },
    );
    const [request, url] = req(urlString);

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("PRIVATE-AUDIO");
    expect(accesses).toEqual([{ operation: "get", key }]);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response?.headers.get("expires")).toBeNull();
    expect(response?.headers.get("content-type")).toBe("audio/mpeg");
    expect(response?.headers.get("content-language")).toBe("en");
    expect(response?.headers.get("content-disposition")).toBe("inline");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("etag")).toBe(`"etag-${key}"`);
    expect(response?.headers.get("accept-ranges")).toBe("bytes");
  });

  test("canonicalizes an IDNA host with a non-default port exactly like the signer", async () => {
    const key = "org/org-1/attachments/idna.bin";
    const now = Math.floor(Date.now() / 1_000);
    const urlString = await mintStorageReadCapabilityUrl({
      rawSecrets: SIGNING_SECRET,
      host: "BÜCHER.Example:8443",
      scopedKey: key,
      issuedAt: now - 1,
      expiresAt: now + 299,
    });
    const { env, accesses } = makeEnv(
      { [key]: { body: "IDNA" } },
      {
        publicHost: "BÜCHER.Example:8443",
        signingSecrets: SIGNING_SECRET,
        withHead: true,
      },
    );
    const [request, url] = req(urlString);

    const response = await serveBlobHostRequest(request, url, env);

    expect(url.host).toBe("xn--bcher-kva.example:8443");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("IDNA");
    expect(accesses).toEqual([{ operation: "get", key }]);
  });

  test("serves HEAD from metadata only", async () => {
    const key = "org/org-1/attachments/archive.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      {
        [key]: { body: "0123456789", contentType: "application/octet-stream" },
      },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        withHead: true,
      },
    );
    const [request, url] = req(urlString, "HEAD");

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-length")).toBe("10");
    expect(response?.headers.get("content-disposition")).toBe("attachment");
    expect(await response?.text()).toBe("");
    expect(accesses).toEqual([{ operation: "head", key }]);
  });

  test("serves one bounded byte range through native R2 range GET", async () => {
    const key = "org/org-1/attachments/archive.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      {
        [key]: { body: "0123456789", contentType: "application/octet-stream" },
      },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        withHead: true,
      },
    );
    const [request, url] = req(urlString, "GET", { range: "bytes=2-5" });

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe("2345");
    expect(response?.headers.get("content-length")).toBe("4");
    expect(response?.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response?.headers.get("accept-ranges")).toBe("bytes");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(accesses).toEqual([
      { operation: "head", key },
      {
        operation: "get",
        key,
        range: { offset: 2, length: 4 },
        onlyIf: { etagMatches: `etag-${key}` },
      },
    ]);
  });

  test("fails closed when the object changes between range HEAD and GET", async () => {
    const key = "org/org-1/attachments/raced.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      { [key]: { body: "0123456789" } },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        withHead: true,
        conditionalMiss: true,
      },
    );
    const [request, url] = req(urlString, "GET", { range: "bytes=2-5" });

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(503);
    expect(response?.headers.get("content-range")).toBeNull();
    expect(accesses).toEqual([
      { operation: "head", key },
      {
        operation: "get",
        key,
        range: { offset: 2, length: 4 },
        onlyIf: { etagMatches: `etag-${key}` },
      },
    ]);
  });

  test("maps an unexpected private GET failure to a safe unavailable response", async () => {
    const key = "org/org-1/attachments/provider-error.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      { [key]: { body: "PRIVATE" } },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        getError: new Error("private-key-sentinel"),
      },
    );
    const [request, url] = req(urlString);

    const response = await serveBlobHostRequest(request, url, env);
    const responseText = await response?.text();

    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(responseText).not.toContain("private-key-sentinel");
    expect(accesses).toEqual([{ operation: "get", key }]);
  });

  test("maps an unexpected private HEAD failure to a bodyless unavailable response", async () => {
    const key = "org/org-1/attachments/provider-error.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      { [key]: { body: "PRIVATE" } },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        withHead: true,
        headError: new Error("private-key-sentinel"),
      },
    );
    const [request, url] = req(urlString, "HEAD");

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.text()).toBe("");
    expect(accesses).toEqual([{ operation: "head", key }]);
  });

  test("maps an unexpected ranged GET failure without leaking range metadata", async () => {
    const key = "org/org-1/attachments/provider-error.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      { [key]: { body: "0123456789" } },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        withHead: true,
        getError: new Error("private-key-sentinel"),
      },
    );
    const [request, url] = req(urlString, "GET", { range: "bytes=2-5" });

    const response = await serveBlobHostRequest(request, url, env);
    const responseText = await response?.text();

    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("content-range")).toBeNull();
    expect(responseText).not.toContain("private-key-sentinel");
    expect(accesses).toEqual([
      { operation: "head", key },
      {
        operation: "get",
        key,
        range: { offset: 2, length: 4 },
        onlyIf: { etagMatches: `etag-${key}` },
      },
    ]);
  });

  test.each([
    ["bytes=7-", "789", "bytes 7-9/10", { offset: 7, length: 3 }],
    ["bytes=-3", "789", "bytes 7-9/10", { offset: 7, length: 3 }],
    ["bytes=8-99", "89", "bytes 8-9/10", { offset: 8, length: 2 }],
  ])(
    "normalizes valid single range %s",
    async (rangeHeader, expectedBody, expectedContentRange, expectedRange) => {
      const key = "org/org-1/attachments/range.bin";
      const urlString = await signedUrl(key);
      const { env, accesses } = makeEnv(
        { [key]: { body: "0123456789" } },
        {
          publicHost: SIGNED_HOST,
          signingSecrets: SIGNING_SECRET,
          withHead: true,
        },
      );
      const [request, url] = req(urlString, "GET", {
        range: rangeHeader,
      });

      const response = await serveBlobHostRequest(request, url, env);

      expect(response?.status).toBe(206);
      expect(await response?.text()).toBe(expectedBody);
      expect(response?.headers.get("content-range")).toBe(expectedContentRange);
      expect(accesses.at(-1)).toEqual({
        operation: "get",
        key,
        range: expectedRange,
        onlyIf: { etagMatches: `etag-${key}` },
      });
    },
  );

  test.each([
    "bytes=0-1,3-4",
    "bytes=9-2",
    "bytes=-0",
    "items=0-1",
    "bytes=99999999999999999-",
    "bytes=-",
  ])(
    "rejects malformed or multiple range %s before R2",
    async (rangeHeader) => {
      const key = "org/org-1/attachments/range.bin";
      const urlString = await signedUrl(key);
      const { env, accesses } = makeEnv(
        { [key]: { body: "0123456789" } },
        {
          publicHost: SIGNED_HOST,
          signingSecrets: SIGNING_SECRET,
          withHead: true,
        },
      );
      const [request, url] = req(urlString, "GET", { range: rangeHeader });

      const response = await serveBlobHostRequest(request, url, env);

      expect(response?.status).toBe(416);
      expect(accesses).toEqual([]);
    },
  );

  test("rejects an unsatisfiable range after metadata-only HEAD", async () => {
    const key = "org/org-1/attachments/range.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      { [key]: { body: "0123456789" } },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        withHead: true,
      },
    );
    const [request, url] = req(urlString, "GET", { range: "bytes=10-" });

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(416);
    expect(response?.headers.get("content-range")).toBe("bytes */10");
    expect(accesses).toEqual([{ operation: "head", key }]);
  });

  test("returns the same private 404 for tampered, expired, and missing objects", async () => {
    const key = "org/org-1/attachments/missing.bin";
    const validUrl = await signedUrl(key);
    const tamperedUrl = `${validUrl.slice(0, -1)}${validUrl.endsWith("A") ? "B" : "A"}`;
    const now = Math.floor(Date.now() / 1_000);
    const expiredUrl = await signedUrl(key, {
      issuedAt: now - 120,
      expiresAt: now - 60,
    });

    for (const candidate of [tamperedUrl, expiredUrl, validUrl]) {
      const { env, accesses } = makeEnv(
        {},
        {
          publicHost: SIGNED_HOST,
          signingSecrets: SIGNING_SECRET,
          withHead: true,
        },
      );
      const [request, url] = req(candidate);
      const response = await serveBlobHostRequest(request, url, env);

      expect(response?.status).toBe(404);
      expect(response?.headers.get("cache-control")).toBe("private, no-store");
      if (candidate === validUrl) {
        expect(accesses).toEqual([{ operation: "get", key }]);
      } else {
        expect(accesses).toEqual([]);
      }
    }
  });

  test("fails closed before R2 when the signing secret is missing", async () => {
    const key = "org/org-1/attachments/private.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      { [key]: { body: "PRIVATE" } },
      { publicHost: SIGNED_HOST, withHead: true },
    );
    const [request, url] = req(urlString);

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      code: "storage_unavailable",
    });
    expect(accesses).toEqual([]);
  });

  test("returns a safe private 503 for invalid host configuration without changing public fallback", async () => {
    const key = "org/org-1/attachments/private.bin";
    const now = Math.floor(Date.now() / 1_000);
    const urlString = await mintStorageReadCapabilityUrl({
      rawSecrets: SIGNING_SECRET,
      host: "blob.eliza.app",
      scopedKey: key,
      issuedAt: now - 1,
      expiresAt: now + 299,
    });
    const { env, accesses } = makeEnv(
      {
        [key]: { body: "PRIVATE" },
        "avatars/eliza.png": { body: "PUBLIC" },
      },
      {
        publicHost: "https://blob.eliza.app/invalid",
        signingSecrets: SIGNING_SECRET,
        withHead: true,
      },
    );
    const [capabilityRequest, capabilityUrl] = req(urlString);
    const [publicRequest, publicUrl] = req(
      "https://blob.eliza.app/avatars/eliza.png",
    );

    const capabilityResponse = await serveBlobHostRequest(
      capabilityRequest,
      capabilityUrl,
      env,
    );

    expect(capabilityResponse?.status).toBe(503);
    expect(capabilityResponse?.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(
      await serveBlobHostRequest(publicRequest, publicUrl, env),
    ).toBeNull();
    expect(accesses).toEqual([]);
  });

  test("never emits a response body for signed HEAD failures", async () => {
    const key = "org/org-1/attachments/private.bin";
    const validUrl = await signedUrl(key);
    const tamperedUrl = `${validUrl.slice(0, -1)}${validUrl.endsWith("A") ? "B" : "A"}`;

    for (const [candidate, signingSecrets, expectedStatus] of [
      [tamperedUrl, SIGNING_SECRET, 404],
      [validUrl, undefined, 503],
    ] as const) {
      const { env, accesses } = makeEnv(
        { [key]: { body: "PRIVATE" } },
        {
          publicHost: SIGNED_HOST,
          ...(signingSecrets ? { signingSecrets } : {}),
          withHead: true,
        },
      );
      const [request, url] = req(candidate, "HEAD");

      const response = await serveBlobHostRequest(request, url, env);

      expect(response?.status).toBe(expectedStatus);
      expect(response?.body).toBeNull();
      expect(await response?.text()).toBe("");
      expect(accesses).toEqual([]);
    }
  });

  test("requires an explicit R2_PUBLIC_HOST for private capabilities", async () => {
    const key = "org/org-1/attachments/private.bin";
    const urlString = await mintStorageReadCapabilityUrl({
      rawSecrets: SIGNING_SECRET,
      host: "blob.eliza.app",
      scopedKey: key,
      issuedAt: Math.floor(Date.now() / 1_000) - 1,
      expiresAt: Math.floor(Date.now() / 1_000) + 299,
    });
    const { env, accesses } = makeEnv(
      { [key]: { body: "PRIVATE" } },
      { signingSecrets: SIGNING_SECRET, withHead: true },
    );
    const [request, url] = req(urlString);

    const response = await serveBlobHostRequest(request, url, env);

    expect(response?.status).toBe(404);
    expect(accesses).toEqual([]);
  });

  test("terminates the capability namespace on a different host and rejects the wrong method without R2", async () => {
    const key = "org/org-1/attachments/private.bin";
    const urlString = await signedUrl(key);
    const { env, accesses } = makeEnv(
      { [key]: { body: "PRIVATE" } },
      {
        publicHost: SIGNED_HOST,
        signingSecrets: SIGNING_SECRET,
        withHead: true,
      },
    );
    const wrongHostUrl = new URL(urlString);
    wrongHostUrl.host = "other.example.test";
    const [hostRequest, hostUrl] = req(wrongHostUrl.toString());
    const [methodRequest, methodUrl] = req(urlString, "POST");

    const hostResponse = await serveBlobHostRequest(hostRequest, hostUrl, env);
    expect(hostResponse?.status).toBe(404);
    expect(hostResponse?.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    const methodResponse = await serveBlobHostRequest(
      methodRequest,
      methodUrl,
      env,
    );
    expect(methodResponse?.status).toBe(405);
    expect(methodResponse?.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(accesses).toEqual([]);
  });
});
