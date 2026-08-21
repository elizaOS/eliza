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
} from "../../types/social-media";
import { assertSocialMediaBytesWithinBudget, decodeSocialMediaBase64 } from "./media-download";

function base64Of(byteLength: number): string {
  return Buffer.alloc(byteLength, 0x41).toString("base64");
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

  test("accepts a MIME line-wrapped payload under the budget", () => {
    const raw = Buffer.alloc(64 * 1024, 0x42);
    const wrapped = (raw.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
    expect(wrapped.length).toBeGreaterThan(raw.toString("base64").length);

    const bytes = decodeSocialMediaBase64(wrapped);
    expect(bytes.length).toBe(raw.length);
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
    const error = rejection(() => decodeSocialMediaBase64("A".repeat(encodedLength)));

    expect(error.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
    // `encodedLength` is only reported by the pre-allocation branch; the
    // post-decode branch reports `receivedBytes`.
    expect(error.context).toMatchObject({
      encodedLength,
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
