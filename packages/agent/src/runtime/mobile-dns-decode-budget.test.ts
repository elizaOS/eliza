/**
 * Behavioral coverage for the mobile DNS fetch decoded-byte budget.
 * Drives the real module and real zlib gzip/deflate/brotli codecs: credit
 * ordering, exact-cap admission, overflow, empty and identity encodings,
 * and stream teardown when the limiter rejects. No mocked collaborators.
 */
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  creditDecodedBodyBytes,
  decodeMobileFetchBody,
  MAX_MOBILE_DNS_DECODED_BYTES,
  MobileFetchDecodeBudgetError,
} from "./mobile-dns-decode-budget.ts";

function gzipBytes(byteLength: number): Buffer {
  return zlib.gzipSync(Buffer.alloc(byteLength, 0));
}

function deflateBytes(byteLength: number): Buffer {
  return zlib.deflateSync(Buffer.alloc(byteLength, 0));
}

function brotliBytes(byteLength: number): Buffer {
  return zlib.brotliCompressSync(Buffer.alloc(byteLength, 0));
}

async function readDecoded(
  source: Readable,
  contentEncoding: string,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const decoded = decodeMobileFetchBody(source, contentEncoding, maxBytes);
  for await (const chunk of decoded) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("mobile-dns-decode-budget", () => {
  it("publishes a 64 MiB production decoded-body cap", () => {
    expect(MAX_MOBILE_DNS_DECODED_BYTES).toBe(64 * 1024 * 1024);
  });

  it("credits a single chunk under the cap and leaves later callers the remainder", () => {
    const state = { bytes: 0 };
    creditDecodedBodyBytes(state, 40, 100);
    expect(state.bytes).toBe(40);
    creditDecodedBodyBytes(state, 60, 100);
    expect(state.bytes).toBe(100);
  });

  it("admits a credit that lands exactly on the cap (strict greater-than)", () => {
    const state = { bytes: 0 };
    creditDecodedBodyBytes(state, 0, 0);
    expect(state.bytes).toBe(0);
    creditDecodedBodyBytes(state, 16, 16);
    expect(state.bytes).toBe(16);
  });

  it("rejects the credit that first overflows and records the post-add total", () => {
    const state = { bytes: 10 };
    try {
      creditDecodedBodyBytes(state, 6, 15);
      expect.fail("expected decode-budget rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MobileFetchDecodeBudgetError);
      expect(error).toMatchObject({
        name: "MobileFetchDecodeBudgetError",
        code: "MOBILE_FETCH_DECODE_TOO_LARGE",
        decodedBytes: 16,
        maxBytes: 15,
        message: "mobile DNS fetch decoded body exceeded 15 bytes (got 16)",
        context: { decodedBytes: 16, maxBytes: 15 },
      });
      expect(state.bytes).toBe(16);
    }
  });

  it("defaults the credit cap to MAX_MOBILE_DNS_DECODED_BYTES", () => {
    const atCap = { bytes: MAX_MOBILE_DNS_DECODED_BYTES };
    creditDecodedBodyBytes(atCap, 0);
    expect(atCap.bytes).toBe(MAX_MOBILE_DNS_DECODED_BYTES);

    const over = { bytes: MAX_MOBILE_DNS_DECODED_BYTES };
    expect(() => creditDecodedBodyBytes(over, 1)).toThrow(
      MobileFetchDecodeBudgetError,
    );
    expect(over.bytes).toBe(MAX_MOBILE_DNS_DECODED_BYTES + 1);
  });

  it("returns an uncompressed source unchanged for identity and unknown encodings", () => {
    const identity = Readable.from([Buffer.from("plain")]);
    expect(decodeMobileFetchBody(identity, "identity", 1)).toBe(identity);

    const empty = Readable.from([Buffer.from("plain")]);
    expect(decodeMobileFetchBody(empty, "", 1)).toBe(empty);

    const upper = Readable.from([Buffer.from("plain")]);
    expect(decodeMobileFetchBody(upper, "GZIP", 1)).toBe(upper);

    const other = Readable.from([Buffer.from("plain")]);
    expect(decodeMobileFetchBody(other, "compress", 1)).toBe(other);
  });

  it("decodes an empty gzip body without applying a false overflow", async () => {
    const out = await readDecoded(Readable.from([gzipBytes(0)]), "gzip", 0);
    expect(out.length).toBe(0);
  });

  it("admits a gzip whose decoded size equals the budget", async () => {
    const raw = 2048;
    const out = await readDecoded(Readable.from([gzipBytes(raw)]), "gzip", raw);
    expect(out.length).toBe(raw);
  });

  it("inflates a zlib-wrapped deflate body under the budget", async () => {
    const raw = 1024;
    const out = await readDecoded(
      Readable.from([deflateBytes(raw)]),
      "deflate",
      raw,
    );
    expect(out.length).toBe(raw);
  });

  it("decompresses a brotli body under the budget", async () => {
    const raw = 1024;
    const out = await readDecoded(Readable.from([brotliBytes(raw)]), "br", raw);
    expect(out.length).toBe(raw);
  });

  it("rejects a gzip inflate that crosses the cap and tears down the source", async () => {
    const raw = 16 * 1024;
    const compressed = gzipBytes(raw);
    expect(compressed.length).toBeLessThan(raw);
    const source = Readable.from([compressed]);
    const decoded = decodeMobileFetchBody(source, "gzip", 1024);
    await expect(
      (async () => {
        for await (const _chunk of decoded) {
          // Drain so the limiter error reaches the consumer.
        }
      })(),
    ).rejects.toMatchObject({
      name: "MobileFetchDecodeBudgetError",
      code: "MOBILE_FETCH_DECODE_TOO_LARGE",
      maxBytes: 1024,
    });
    expect(source.destroyed).toBe(true);
  });

  it("rejects a deflate inflate past the cap", async () => {
    await expect(
      readDecoded(Readable.from([deflateBytes(8192)]), "deflate", 256),
    ).rejects.toMatchObject({
      code: "MOBILE_FETCH_DECODE_TOO_LARGE",
      maxBytes: 256,
    });
  });

  it("rejects a brotli inflate past the cap", async () => {
    await expect(
      readDecoded(Readable.from([brotliBytes(8192)]), "br", 256),
    ).rejects.toMatchObject({
      code: "MOBILE_FETCH_DECODE_TOO_LARGE",
      maxBytes: 256,
    });
  });

  it("forwards a malformed gzip decoder failure to the consumer", async () => {
    const decoded = decodeMobileFetchBody(
      Readable.from([Buffer.from("not gzip")]),
      "gzip",
    );
    await expect(
      (async () => {
        for await (const _chunk of decoded) {
          // Drain the production stream so decoder errors reach the consumer.
        }
      })(),
    ).rejects.toBeInstanceOf(Error);
  });

  it("forwards a malformed deflate decoder failure to the consumer", async () => {
    await expect(
      readDecoded(Readable.from([Buffer.from("not deflate")]), "deflate", 64),
    ).rejects.toBeInstanceOf(Error);
  });
});
