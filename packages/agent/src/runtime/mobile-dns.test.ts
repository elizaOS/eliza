/**
 * Deterministic coverage for the mobile DNS-pinned fetch decode budget.
 * The harness is real zlib (gzip of zeros) with no network and no mocked
 * collaborators. `configureMobileDnsIfNeeded` is a no-op off mobile, so tests
 * exercise the production decoder used by the fetch wrapper.
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

function gzipZeros(bytes: number): Buffer {
  return zlib.gzipSync(Buffer.alloc(bytes, 0));
}

async function gunzipWithBudget(
  compressed: Buffer,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const decoded = decodeMobileFetchBody(
    Readable.from([compressed]),
    "gzip",
    maxBytes,
  );
  for await (const chunk of decoded) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("mobile DNS fetch decode budget", () => {
  it("credits decoded chunks and rejects past the cap before more enqueue", () => {
    const state = { bytes: 0 };
    creditDecodedBodyBytes(state, 100, 150);
    expect(state.bytes).toBe(100);
    try {
      creditDecodedBodyBytes(state, 51, 150);
      expect.fail("expected decode-budget rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MobileFetchDecodeBudgetError);
      expect(error).toMatchObject({
        code: "MOBILE_FETCH_DECODE_TOO_LARGE",
        decodedBytes: 151,
        maxBytes: 150,
      });
    }
  });

  it("admits a zeros gzip whose decoded size stays inside the budget", async () => {
    const raw = 256 * 1024;
    const out = await gunzipWithBudget(gzipZeros(raw), raw);
    expect(out.length).toBe(raw);
  });

  it("rejects a zeros gzip bomb before materializing the declared inflate", async () => {
    const raw = 2 * 1024 * 1024;
    const compressed = gzipZeros(raw);
    expect(compressed.length).toBeLessThan(64 * 1024);
    await expect(
      gunzipWithBudget(compressed, 512 * 1024),
    ).rejects.toMatchObject({
      code: "MOBILE_FETCH_DECODE_TOO_LARGE",
      maxBytes: 512 * 1024,
    });
  });

  it("keeps the production cap above typical API bodies and below multi-GiB inflates", () => {
    expect(MAX_MOBILE_DNS_DECODED_BYTES).toBe(64 * 1024 * 1024);
  });

  it("passes an uncompressed stream through without applying the inflate cap", () => {
    const source = Readable.from([Buffer.alloc(16)]);
    expect(decodeMobileFetchBody(source, "identity", 1)).toBe(source);
  });

  it("forwards malformed compressed-body failures to the consumer", async () => {
    const decoded = decodeMobileFetchBody(
      Readable.from([Buffer.from("not gzip")]),
      "gzip",
    );
    await expect(async () => {
      for await (const _chunk of decoded) {
        // Drain the production stream so decoder errors reach the consumer.
      }
    }).toThrow();
  });
});
