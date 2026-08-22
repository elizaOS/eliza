/**
 * Pins the shared social-media byte budget on the branches that are NOT a URL
 * download.
 *
 * #22604 bound the `media.url` branch of every provider's media chain against
 * `SOCIAL_MEDIA_MEDIA_MAX_BYTES`. The `media.data` and `media.base64` siblings
 * of the same `if/else` allocated whatever the caller sent, so the accepted
 * budget was bypassed by choosing a different field on the same attachment.
 *
 * Two contracts are under test:
 *   1. The budget is charged against DECODED bytes and is charged BEFORE
 *      `Buffer.from` allocates, via the exact encoded-length equivalent.
 *   2. It does not over-reject: a payload the URL branch would have accepted
 *      (up to and including the budget exactly) still decodes, whether or not
 *      it carries the ignorable characters of MIME line wrapping.
 */
import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

import {
  SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH,
  SOCIAL_MEDIA_MEDIA_MAX_BYTES,
  SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES,
  SOCIAL_MEDIA_VIDEO_MAX_BYTES,
} from "../../types/social-media";
import { assertSocialMediaBytesWithinBudget, decodeSocialMediaBase64 } from "./media-download";

function base64Of(byteLength: number): string {
  return Buffer.alloc(byteLength, 0x41).toString("base64");
}

function mimeWrap(base64: string): string {
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 76) {
    lines.push(base64.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

function rejection(run: () => unknown): ElizaError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ElizaError);
    return error as ElizaError;
  }
  throw new Error("expected the budget guard to reject, but it returned");
}

describe("SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH", () => {
  test("is the exact encoded length of a maximum-size payload", () => {
    expect(base64Of(SOCIAL_MEDIA_MEDIA_MAX_BYTES).length).toBe(
      SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH,
    );
  });
});

describe("decodeSocialMediaBase64", () => {
  test("decodes an ordinary attachment", () => {
    const bytes = decodeSocialMediaBase64(Buffer.from("PNGBYTES").toString("base64"));
    expect(bytes.toString()).toBe("PNGBYTES");
  });

  test("accepts a payload of exactly the budget — the URL branch accepts it too", () => {
    const bytes = decodeSocialMediaBase64(base64Of(SOCIAL_MEDIA_MEDIA_MAX_BYTES));
    expect(bytes.length).toBe(SOCIAL_MEDIA_MEDIA_MAX_BYTES);
  });

  test("accepts an exact-budget MIME line-wrapped payload", () => {
    const encoded = base64Of(SOCIAL_MEDIA_MEDIA_MAX_BYTES);
    const wrapped = mimeWrap(encoded);
    expect(wrapped.length).toBeGreaterThan(encoded.length);

    const bytes = decodeSocialMediaBase64(wrapped);
    expect(bytes.length).toBe(SOCIAL_MEDIA_MEDIA_MAX_BYTES);
  });

  test("rejects a wrapped payload one byte over the budget after decoding", () => {
    const wrapped = mimeWrap(base64Of(SOCIAL_MEDIA_MEDIA_MAX_BYTES + 1));

    const error = rejection(() => decodeSocialMediaBase64(wrapped));
    expect(error.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
    expect(error.context).toMatchObject({
      receivedBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES + 1,
      maxBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES,
    });
  });

  test("rejects one byte over the budget after decoding — the encoded length is identical", () => {
    const oversize = base64Of(SOCIAL_MEDIA_MEDIA_MAX_BYTES + 1);
    // 4*ceil(n/3) is unchanged by this byte, so the pre-check cannot see it and
    // the post-decode charge is what closes the hole.
    expect(oversize.length).toBe(SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH);

    const error = rejection(() => decodeSocialMediaBase64(oversize));
    expect(error.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
    expect(error.context).toMatchObject({
      receivedBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES + 1,
      maxBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES,
    });
  });

  test("rejects an oversized payload BEFORE the decode allocates", () => {
    const encodedLength = SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH + 4;
    const encoded = ` \t\r\n${"A".repeat(encodedLength)}\r\n `;
    const error = rejection(() => decodeSocialMediaBase64(encoded));

    expect(error.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
    // `encodedLength` is only reported by the pre-allocation branch; the
    // post-decode branch reports `receivedBytes`.
    expect(error.context).toMatchObject({
      encodedLength,
      rawEncodedLength: encoded.length,
      maxEncodedLength: SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH,
    });
    expect(error.context).not.toHaveProperty("receivedBytes");
  });

  test("carries the caller context into the typed error", () => {
    const error = rejection(() =>
      decodeSocialMediaBase64("A".repeat(SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH + 4), {
        platform: "bluesky",
      }),
    );
    expect(error.context).toMatchObject({ platform: "bluesky" });
  });
});

describe("assertSocialMediaBytesWithinBudget", () => {
  test("passes at exactly the budget", () => {
    expect(() => assertSocialMediaBytesWithinBudget(SOCIAL_MEDIA_MEDIA_MAX_BYTES)).not.toThrow();
  });

  test("rejects one byte past the budget", () => {
    const error = rejection(() =>
      assertSocialMediaBytesWithinBudget(SOCIAL_MEDIA_MEDIA_MAX_BYTES + 1, {
        platform: "slack",
      }),
    );
    expect(error.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
    expect(error.context).toMatchObject({
      receivedBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES + 1,
      maxBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES,
      platform: "slack",
    });
  });
});

// TikTok accepts larger URL-backed videos, but inline video keeps the encoded
// input and decoded bytes resident together in the Worker isolate.
describe("video budget", () => {
  test("keeps the decoded binary ceiling at 32 MiB for reachable multi-range uploads", () => {
    expect(SOCIAL_MEDIA_VIDEO_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(() =>
      assertSocialMediaBytesWithinBudget(
        SOCIAL_MEDIA_VIDEO_MAX_BYTES,
        { platform: "tiktok" },
        SOCIAL_MEDIA_VIDEO_MAX_BYTES,
      ),
    ).not.toThrow();
  });

  test("uses the shared 10 MiB ceiling for base64 video and accepts it exactly", () => {
    expect(SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES).toBe(SOCIAL_MEDIA_MEDIA_MAX_BYTES);
    const bytes = decodeSocialMediaBase64(
      base64Of(SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES),
      { platform: "tiktok" },
      SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES,
    );
    expect(bytes.length).toBe(SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES);
  });

  test("still rejects a payload above the video ceiling", () => {
    const rejected = rejection(() =>
      assertSocialMediaBytesWithinBudget(
        SOCIAL_MEDIA_VIDEO_MAX_BYTES + 1,
        { platform: "tiktok" },
        SOCIAL_MEDIA_VIDEO_MAX_BYTES,
      ),
    );
    expect(rejected.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
    expect(rejected.context?.maxBytes).toBe(SOCIAL_MEDIA_VIDEO_MAX_BYTES);
  });

  test("rejects an oversize base64 video before the decode allocates", () => {
    const encoded = "A".repeat(Math.ceil(SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES / 3) * 4 + 4);
    const rejected = rejection(() =>
      decodeSocialMediaBase64(encoded, { platform: "tiktok" }, SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES),
    );
    expect(rejected.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
    expect(rejected.context?.encodedLength).toBeGreaterThan(0);
  });

  test("rejects whitespace stuffing beyond RFC 2045 wrapping before decode", () => {
    const maxEncodedLength = Math.ceil(SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES / 3) * 4;
    const maxRawEncodedLength =
      maxEncodedLength + Math.max(0, Math.ceil(maxEncodedLength / 76) - 1) * 2;
    const rejected = rejection(() =>
      decodeSocialMediaBase64(
        " ".repeat(maxRawEncodedLength + 1),
        { platform: "tiktok" },
        SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES,
      ),
    );
    expect(rejected.context).toMatchObject({
      rawEncodedLength: maxRawEncodedLength + 1,
      maxRawEncodedLength,
    });
    expect(rejected.context).not.toHaveProperty("receivedBytes");
  });

  test("bounds two overlapping binary or base64 uploads below a 128 MiB isolate", () => {
    const workerLimit = 128 * 1024 * 1024;
    const maxChunkCopy = 10_000_000;
    const maxBase64Encoded = Math.ceil(SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES / 3) * 4;
    const maxBase64Raw = maxBase64Encoded + Math.max(0, Math.ceil(maxBase64Encoded / 76) - 1) * 2;

    expect(2 * (SOCIAL_MEDIA_VIDEO_MAX_BYTES + maxChunkCopy)).toBeLessThan(workerLimit);
    expect(2 * (maxBase64Raw + SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES + maxChunkCopy)).toBeLessThan(
      workerLimit,
    );
  });
});
