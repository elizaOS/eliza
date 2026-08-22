/** Verifies quote-tweet request assembly at the final X API client boundary. */

import { describe, expect, it, vi } from "vitest";
import type { TwitterAuth } from "./auth";
import { createQuoteTweetRequest } from "./tweets";

describe("createQuoteTweetRequest", () => {
  it("preserves uploaded media ids on the quote tweet", async () => {
    const tweet = vi.fn(async () => ({ data: { id: "quote-1" } }));
    const auth = {
      getV2Client: async () => ({ v2: { tweet } }),
    } as unknown as TwitterAuth;

    await createQuoteTweetRequest("context", "source-1", auth, undefined, [
      "media-1",
      "media-2",
    ]);

    expect(tweet).toHaveBeenCalledWith({
      text: "context https://twitter.com/i/status/source-1",
      media: { media_ids: ["media-1", "media-2"] },
    });
  });

  it("rejects invalid media arity before the provider write", async () => {
    const tweet = vi.fn();
    const auth = {
      getV2Client: async () => ({ v2: { tweet } }),
    } as unknown as TwitterAuth;

    await createQuoteTweetRequest("context", "source-1", auth, undefined, []);
    expect(tweet).toHaveBeenCalledWith({
      text: "context https://twitter.com/i/status/source-1",
    });

    tweet.mockClear();
    await expect(
      createQuoteTweetRequest("context", "source-1", auth, undefined, [
        "1",
        "2",
        "3",
        "4",
        "5",
      ]),
    ).rejects.toMatchObject({
      code: "X_QUOTE_REQUEST_FAILED",
      cause: expect.objectContaining({
        message: expect.stringContaining("between 1 and 4"),
      }),
    });
    expect(tweet).not.toHaveBeenCalled();
  });
});
